import { WebGLRenderer } from "./renderer/webgl_renderer.js";
import { AudioRenderer } from "./audio/audio_renderer.js";
import { HlsController } from "./hls/hls_controller.js";
import { WasmBridge } from "./wasm/wasm_bridge.js";

export class HlsWasmPlayer {
  constructor({ canvas, wasmJsUrl, wasmFileUrl, log }) {
    this.canvas = canvas;
    this.log = log || (() => {});

    this.renderer = new WebGLRenderer(canvas);
    this.audio = new AudioRenderer();
    this.wasm = new WasmBridge({ wasmJsUrl, wasmFileUrl });

    this.hls = null;
    this.running = false;

    this.videoQueue = [];
    this.videoClockOffsetSec = null;
    this.renderRafId = 0;

    this.maxVideoQueueSize = 600;
    this.videoQueueHighWatermark = 300;
    this.maxAudioBufferedSec = 1.8;
    this.maxVideoLeadSec = 1.2;
    this.dropLateFrameSec = 0.2;

    this.droppedVideoFrames = 0;
    this.lastDropLogAt = 0;

    this.lastVideoRawPtsMs = null;
    this.lastVideoNormPtsMs = null;
    this.videoFrameDurMs = 33.33;

    this.lastAudioRawPtsMs = null;
    this.lastAudioNormPtsMs = null;
  }

  async init() {
    await this.audio.init();

    await this.wasm.init({
      onVideoFrame: (width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs) => {
        const ySize = yStride * height;
        const uvHeight = height >> 1;
        const uSize = uStride * uvHeight;
        const vSize = vStride * uvHeight;

        const y = new Uint8Array(this.wasm.module.HEAPU8.buffer, yPtr, ySize).slice();
        const u = new Uint8Array(this.wasm.module.HEAPU8.buffer, uPtr, uSize).slice();
        const v = new Uint8Array(this.wasm.module.HEAPU8.buffer, vPtr, vSize).slice();

        const normalizedPtsMs = this.#normalizeVideoPts(ptsMs);
        this.#enqueueVideoFrame({
          width,
          height,
          y,
          u,
          v,
          yStride,
          uStride,
          vStride,
          ptsMs: normalizedPtsMs,
        });
      },
      onAudioFrame: (channels, sampleRate, sampleCount, dataPtr, ptsMs) => {
        const sampleNum = channels * sampleCount;
        const pcm = new Float32Array(this.wasm.module.HEAPU8.buffer, dataPtr, sampleNum).slice();
        const normalizedPtsMs = this.#normalizeAudioPts(ptsMs, sampleCount, sampleRate);
        this.audio.enqueueFrame({ channels, sampleRate, sampleCount, pcm, ptsMs: normalizedPtsMs });
      },
      onLog: (level, msg) => {
        this.log(`[wasm:${level}] ${msg}`);
      },
    });
  }

  async start(url, mode) {
    if (this.running) {
      await this.stop();
    }

    this.running = true;
    this.videoQueue.length = 0;
    this.videoClockOffsetSec = null;
    this.droppedVideoFrames = 0;
    this.lastDropLogAt = 0;
    this.lastVideoRawPtsMs = null;
    this.lastVideoNormPtsMs = null;
    this.videoFrameDurMs = 33.33;
    this.lastAudioRawPtsMs = null;
    this.lastAudioNormPtsMs = null;
    this.#startRenderLoop();

    this.hls = new HlsController({
      mode,
      lowLatency: true,
      onSegment: async (bytes, isInitSegment, segmentUrl) => {
        await this.#waitForFlowControl();
        this.wasm.feedSegment(bytes, isInitSegment);
        this.log(`${isInitSegment ? "init" : "seg"}: ${segmentUrl}`);
      },
    });

    this.log(`Start ${mode} playback: ${url}`);
    this.hls.start(url);
  }

  async stop() {
    this.running = false;

    if (this.hls) {
      this.hls.stop();
      this.hls = null;
    }

    if (this.renderRafId) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = 0;
    }

    this.videoQueue.length = 0;
    this.videoClockOffsetSec = null;
    this.droppedVideoFrames = 0;
    this.lastDropLogAt = 0;
    this.lastVideoRawPtsMs = null;
    this.lastVideoNormPtsMs = null;
    this.videoFrameDurMs = 33.33;
    this.lastAudioRawPtsMs = null;
    this.lastAudioNormPtsMs = null;

    this.wasm.reset();
    this.audio.reset();
    this.log("Playback stopped.");
  }

  destroy() {
    this.stop();
    this.wasm.destroy();
  }

  #enqueueVideoFrame(frame) {
    if (!Number.isFinite(frame.ptsMs)) {
      return;
    }

    this.videoQueue.push(frame);
  }

  #startRenderLoop() {
    if (this.renderRafId) {
      cancelAnimationFrame(this.renderRafId);
    }

    const tick = () => {
      if (!this.running) {
        this.renderRafId = 0;
        return;
      }

      let mediaTimeSec = this.audio.getMediaTimeSec();
      if (mediaTimeSec === null && this.videoQueue.length > 0) {
        const nowSec = performance.now() / 1000;
        if (this.videoClockOffsetSec === null) {
          this.videoClockOffsetSec = this.videoQueue[0].ptsMs / 1000 - nowSec;
        }
        mediaTimeSec = nowSec + this.videoClockOffsetSec;
      }

      if (mediaTimeSec !== null) {
        let renderedThisTick = 0;
        while (this.videoQueue.length > 0) {
          const head = this.videoQueue[0];
          const headPtsSec = head.ptsMs / 1000;
          const delta = headPtsSec - mediaTimeSec;

          if (delta > 0.01) {
            break;
          }

          this.videoQueue.shift();
          if (delta < -this.dropLateFrameSec) {
            continue;
          }
          this.renderer.renderYuv420(head);
          renderedThisTick += 1;
          if (renderedThisTick >= 2) {
            break;
          }
        }
      }

      this.renderRafId = requestAnimationFrame(tick);
    };

    this.renderRafId = requestAnimationFrame(tick);
  }

  async #waitForFlowControl() {
    while (this.running) {
      const audioBuffered = this.audio.getBufferedSeconds();
      const videoLeadSec = this.#getVideoLeadSec();
      const queueOk = this.videoQueue.length <= this.videoQueueHighWatermark;
      if (audioBuffered <= this.maxAudioBufferedSec && videoLeadSec <= this.maxVideoLeadSec && queueOk) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  #getVideoLeadSec() {
    if (this.videoQueue.length === 0) {
      return 0;
    }
    const mediaTimeSec = this.audio.getMediaTimeSec();
    if (mediaTimeSec === null) {
      return this.videoQueue.length / 30;
    }
    const tailPtsSec = this.videoQueue[this.videoQueue.length - 1].ptsMs / 1000;
    return Math.max(0, tailPtsSec - mediaTimeSec);
  }

  #normalizeVideoPts(rawPtsMs) {
    const hasRaw = Number.isFinite(rawPtsMs);
    if (this.lastVideoNormPtsMs === null) {
      this.lastVideoRawPtsMs = hasRaw ? rawPtsMs : 0;
      this.lastVideoNormPtsMs = 0;
      return 0;
    }

    let stepMs = this.videoFrameDurMs;
    if (hasRaw && this.lastVideoRawPtsMs !== null) {
      const deltaMs = rawPtsMs - this.lastVideoRawPtsMs;
      if (deltaMs > 2 && deltaMs < 120) {
        stepMs = deltaMs;
        this.videoFrameDurMs = this.videoFrameDurMs * 0.9 + deltaMs * 0.1;
      }
    }

    if (hasRaw) {
      this.lastVideoRawPtsMs = rawPtsMs;
    }
    this.lastVideoNormPtsMs += Math.max(5, stepMs);
    return this.lastVideoNormPtsMs;
  }

  #normalizeAudioPts(rawPtsMs, sampleCount, sampleRate) {
    const frameDurMs = sampleRate > 0 ? (sampleCount * 1000) / sampleRate : 20;
    const hasRaw = Number.isFinite(rawPtsMs);

    if (this.lastAudioNormPtsMs === null) {
      this.lastAudioRawPtsMs = hasRaw ? rawPtsMs : 0;
      this.lastAudioNormPtsMs = 0;
      return 0;
    }

    let stepMs = frameDurMs;
    if (hasRaw && this.lastAudioRawPtsMs !== null) {
      const deltaMs = rawPtsMs - this.lastAudioRawPtsMs;
      if (deltaMs > 2 && deltaMs < 250) {
        stepMs = deltaMs;
      }
    }

    if (hasRaw) {
      this.lastAudioRawPtsMs = rawPtsMs;
    }
    this.lastAudioNormPtsMs += Math.max(5, stepMs);
    return this.lastAudioNormPtsMs;
  }
}
