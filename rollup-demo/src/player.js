import { WebGLRenderer } from "./renderer/webgl_renderer.js";
import { AudioRenderer } from "./audio/audio_renderer.js";
import { HlsController } from "./hls/hls_controller.js";
import { WasmBridge } from "./wasm/wasm_bridge.js";

export class HlsWasmPlayer {
  constructor({ canvas, wasmJsUrl, wasmFileUrl, log, onIFrame }) {
    this.canvas = canvas;
    this.log = log || (() => {});
    this.onIFrame = onIFrame;

    this.renderer = new WebGLRenderer(canvas);
    this.audio = new AudioRenderer();
    this.wasm = new WasmBridge({ wasmJsUrl, wasmFileUrl });

    this.hls = null;
    this.running = false;
    this._initPromise = null;
    this._initialized = false;

    this.videoQueue = [];
    this.videoClockOffsetSec = null;
    this.renderRafId = 0;

    this.maxVideoQueueSize = 600;
    this.videoQueueHighWatermark = 300;
    this.maxAudioBufferedSec = 3.0;
    this.maxVideoLeadSec = 1.2;
    this.dropLateFrameSec = 0.2;

    this.droppedVideoFrames = 0;
    this.lastDropLogAt = 0;

    this.lastVideoRawPtsMs = null;
    this.lastVideoNormPtsMs = null;
    this.videoFrameDurMs = 33.33;

    this.lastAudioRawPtsMs = null;
    this.lastAudioNormPtsMs = null;

    this.segmentSeq = 0;
    this.segmentInfoQueue = [];
    this.maxPendingSegmentInfo = 60;
    this.hevcCompatFallbackTriggered = false;
    this._totalDuration = 0;
    this._seekBaseTime = 0;
  }

  get currentTime() {
    return this.audio ? this.audio.getMediaTimeSec() : 0;
  }

  async init() {
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      await this.audio.init();
      await this.wasm.init({
        onVideoFrame: (
          width,
          height,
          yPtr,
          yStride,
          uPtr,
          uStride,
          vPtr,
          vStride,
          ptsMs,
          isKeyFrame,
          codecName,
        ) => {
          const ySize = yStride * height;
          const uvHeight = height >> 1;
          const uSize = uStride * uvHeight;
          const vSize = vStride * uvHeight;

          const y = new Uint8Array(
            this.wasm.module.HEAPU8.buffer,
            yPtr,
            ySize,
          ).slice();
          const u = new Uint8Array(
            this.wasm.module.HEAPU8.buffer,
            uPtr,
            uSize,
          ).slice();
          const v = new Uint8Array(
            this.wasm.module.HEAPU8.buffer,
            vPtr,
            vSize,
          ).slice();

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
            isKeyFrame: !!isKeyFrame,
          });

          if (isKeyFrame && this.onIFrame) {
            this.onIFrame(normalizedPtsMs);
          }

          this.#logSegmentVideoInfo(
            width,
            height,
            yStride,
            uStride,
            vStride,
            normalizedPtsMs,
            codecName,
          );
        },
        onAudioFrame: (
          channels,
          sampleRate,
          sampleCount,
          dataPtr,
          ptsMs,
          codecName,
        ) => {
          const sampleNum = channels * sampleCount;
          const pcm = new Float32Array(
            this.wasm.module.HEAPU8.buffer,
            dataPtr,
            sampleNum,
          ).slice();
          const normalizedPtsMs = this.#normalizeAudioPts(
            ptsMs,
            sampleCount,
            sampleRate,
          );
          this.audio.enqueueFrame({
            channels,
            sampleRate,
            sampleCount,
            pcm,
            ptsMs: normalizedPtsMs,
          });

          this.#logSegmentAudioInfo(
            channels,
            sampleRate,
            sampleCount,
            normalizedPtsMs,
            codecName,
          );
        },
        onLog: (level, msg) => {
          this.log(`[wasm:${level}] ${msg}`);
          this.#maybeFallbackFromLowLatency(msg);
        },
      });

      this._initialized = true;
      this.log("WASM module initialized successfully.");
    })();

    return this._initPromise;
  }

  async start(url, mode) {
    if (!this._initialized && this._initPromise) {
      this.log("Waiting for WASM initialization...");
      await this._initPromise;
    }

    if (!this._initialized) {
      throw new Error(
        "WASM player has not been initialized. Call init() first.",
      );
    }

    if (this.running) {
      await this.stop();
    }

    this.hevcCompatFallbackTriggered = false;
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
    this.segmentInfoQueue.length = 0;
    this.#startRenderLoop();

    this.hls = new HlsController({
      mode,
      lowLatency: true,
      onDuration: (dur) => {
        this._totalDuration = dur;
      },
      onSegment: async (bytes, isInitSegment, segmentUrl) => {
        await this.#waitForFlowControl();
        if (!isInitSegment) {
          this.#beginSegmentInfo(segmentUrl, bytes.length);
        }
        this.wasm.feedSegment(bytes, isInitSegment);
        this.log(`${isInitSegment ? "init" : "seg"}: ${segmentUrl}`);
      },
    });

    this.log(`Start ${mode} playback: ${url}`);
    this.hls.start(url);
  }

  async stop() {
    this.running = false;
    if (this._visibilityHandler) {
      document.removeEventListener("visibilitychange", this._visibilityHandler);
      this._visibilityHandler = null;
    }

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
    this.#flushPendingSegmentInfos();
    this.segmentInfoQueue.length = 0;

    this.wasm.reset();
    this.audio.reset();
    this.log("Playback stopped.");
  }

  async destroy() {
    await this.stop();
    this.wasm.destroy();
    this._initialized = false;
    this._initPromise = null;
  }

  /** Current playback time in seconds (from audio clock). */
  getCurrentTime() {
    const t = this.audio.getMediaTimeSec();
    return (t !== null ? t : 0) + this._seekBaseTime;
  }

  /** Total duration in seconds (from playlist). */
  getTotalDuration() {
    return this._totalDuration || 0;
  }

  /** Seek to a target time (seconds). */
  async seek(timeSec) {
    if (!this.running || !this.hls) {
      this.log("Cannot seek: not playing.");
      return;
    }
    this.log(`Seeking to ${timeSec.toFixed(1)}s`);

    // Reset decoder state
    this.wasm.reset();
    this.audio.reset();
    this.videoQueue.length = 0;
    this.videoClockOffsetSec = null;
    this.lastVideoRawPtsMs = null;
    this.lastVideoNormPtsMs = null;
    this.lastAudioRawPtsMs = null;
    this.lastAudioNormPtsMs = null;
    this.droppedVideoFrames = 0;
    this.lastDropLogAt = 0;

    // Seek in HLS controller (restarts loop from target segment)
    const segmentStart = await this.hls.seekTo(timeSec);
    // Use the actual segment start time as the base,
    // so getCurrentTime() reflects the real position.
    this._seekBaseTime = segmentStart;
    this.log(`Seek done, segment starts at ${segmentStart.toFixed(1)}s`);
  }

  #maybeFallbackFromLowLatency(msg) {
    if (!this.hls || !this.hls.lowLatency || this.hevcCompatFallbackTriggered) {
      return;
    }

    const text = String(msg || "").toLowerCase();
    const hevcHeaderParseFailed = text.includes(
      "failed to parse header of nalu",
    );
    const hevcInvalidData =
      text.includes("hevc") && text.includes("invalid data found");

    if (!hevcHeaderParseFailed && !hevcInvalidData) {
      return;
    }

    this.hevcCompatFallbackTriggered = true;
    this.hls.setLowLatency(false);
    this.log(
      "[compat] HEVC NALU parse warning detected. Switched to segment-only mode.",
    );
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

    const onVisibilityChange = () => {
      if (document.hidden) return;
      if (!this.running) return;

      const now = performance.now() / 1000;
      const mediaTime = this.audio.getMediaTimeSec();
      if (mediaTime !== null && this.videoQueue.length > 0) {
        while (this.videoQueue.length > 0) {
          const headPtsSec = this.videoQueue[0].ptsMs / 1000;
          if (headPtsSec < mediaTime - 0.5) {
            this.videoQueue.shift();
          } else {
            break;
          }
        }

        if (this.videoQueue.length > 0) {
          this.videoClockOffsetSec = this.videoQueue[0].ptsMs / 1000 - now;
        } else {
          this.videoClockOffsetSec = null;
        }
      }
    };

    document.addEventListener("visibilitychange", onVisibilityChange);
    this._visibilityHandler = onVisibilityChange;

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
      if (
        audioBuffered <= this.maxAudioBufferedSec &&
        videoLeadSec <= this.maxVideoLeadSec &&
        queueOk
      ) {
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

  #beginSegmentInfo(segmentUrl, byteLength) {
    this.#flushHeadSegmentInfo();

    this.segmentInfoQueue.push({
      id: ++this.segmentSeq,
      segmentUrl,
      byteLength,
      videoInfo: null,
      audioInfo: null,
      printed: false,
    });

    while (this.segmentInfoQueue.length > this.maxPendingSegmentInfo) {
      const stale = this.segmentInfoQueue.shift();
      this.#flushSegmentInfo(stale, true);
    }
  }

  #logSegmentVideoInfo(
    width,
    height,
    yStride,
    uStride,
    vStride,
    ptsMs,
    codecName,
  ) {
    const ctx = this.segmentInfoQueue.find((item) => !item.videoInfo);
    if (!ctx) {
      return;
    }

    ctx.videoInfo = {
      width,
      height,
      yStride,
      uStride,
      vStride,
      ptsMs,
      codecName: codecName || "unknown",
    };
    this.#flushSegmentInfo(ctx, false);
  }

  #logSegmentAudioInfo(channels, sampleRate, sampleCount, ptsMs, codecName) {
    const ctx = this.segmentInfoQueue.find((item) => !item.audioInfo);
    if (!ctx) {
      return;
    }

    ctx.audioInfo = {
      channels,
      sampleRate,
      sampleCount,
      ptsMs,
      codecName: codecName || "unknown",
    };
    this.#flushSegmentInfo(ctx, false);
  }

  #flushSegmentInfo(ctx, force = false) {
    if (!ctx || ctx.printed) {
      return;
    }

    if (!force && (!ctx.videoInfo || !ctx.audioInfo)) {
      return;
    }

    const videoText = ctx.videoInfo
      ? `videoInfo(codec=${ctx.videoInfo.codecName} width=${ctx.videoInfo.width} height=${ctx.videoInfo.height} y=${ctx.videoInfo.yStride} u=${ctx.videoInfo.uStride} v=${ctx.videoInfo.vStride} pts=${ctx.videoInfo.ptsMs.toFixed(2)}ms)`
      : "videoInfo(n/a)";
    const audioText = ctx.audioInfo
      ? `audioInfo(codec=${ctx.audioInfo.codecName} channels=${ctx.audioInfo.channels} sampleRate=${ctx.audioInfo.sampleRate} samples=${ctx.audioInfo.sampleCount} pts=${ctx.audioInfo.ptsMs.toFixed(2)}ms)`
      : "audioInfo(n/a)";

    this.log(
      `[seg-info] #${ctx.id} ${this.#shortSegmentName(ctx.segmentUrl)} size=${ctx.byteLength}B ${videoText} ${audioText}`,
    );

    ctx.printed = true;
    this.#compactSegmentInfoQueue();
  }

  #flushHeadSegmentInfo() {
    if (this.segmentInfoQueue.length === 0) {
      return;
    }
    this.#flushSegmentInfo(this.segmentInfoQueue[0], true);
  }

  #flushPendingSegmentInfos() {
    for (const item of this.segmentInfoQueue) {
      this.#flushSegmentInfo(item, true);
    }
  }

  #compactSegmentInfoQueue() {
    while (this.segmentInfoQueue.length > 0) {
      const head = this.segmentInfoQueue[0];
      if (!head.printed) {
        break;
      }
      this.segmentInfoQueue.shift();
    }
  }

  #shortSegmentName(segmentUrl) {
    try {
      const url = new URL(segmentUrl);
      const parts = url.pathname.split("/");
      return parts[parts.length - 1] || segmentUrl;
    } catch {
      return segmentUrl;
    }
  }
}
