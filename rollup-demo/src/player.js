import { WebGlRender } from "./renderer/webgl-420p";
import { AudioRenderer } from "./audio/audio_renderer";
import { HlsController } from "./hls/hls_controller";
import { WasmBridge } from "./wasm/wasm_bridge";
import TimeRangesLite from "./utils/TimeRangesLite";

export class HlsWasmPlayer {
  constructor({ canvas, wasmJsUrl, wasmFileUrl, log, onIFrame }) {
    this.canvas = canvas;
    this.log = log || (() => {});
    this.onIFrame = onIFrame;

    // Event delegate (HTMLMediaElement-style addEventListener / removeEventListener / dispatchEvent).
    this._events = new EventTarget();

    this.renderer = new WebGlRender(canvas);
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

    // HTMLMediaElement-like state
    this._currentSrc = "";
    this._currentMode = "vod";
    this._paused = true;
    this._ended = false;
    this._volume = 1.0;
    this._muted = false;
    this._playbackRate = 1.0;

    // PTS of the most recently rendered video frame (seconds, normalized).
    this._lastRenderedFramePtsSec = null;

    // Event-emission bookkeeping
    this._timeUpdateTimerId = 0;
    this._lastEmittedTimeSec = -1;
    this._loadedMetadataFired = false;
    this._playingFired = false;
    this._waitingFired = false;
    this._lastDurationFired = -1;
  }

  /* ============================================================== */
  /* Event API (HTMLMediaElement-style)                              */
  /* ============================================================== */

  addEventListener(type, listener, options) {
    return this._events.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    return this._events.removeEventListener(type, listener, options);
  }
  dispatchEvent(event) {
    return this._events.dispatchEvent(event);
  }

  #emit(type, detail) {
    try {
      this._events.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (err) {
      console.error(`[player] listener for "${type}" threw:`, err);
    }
  }

  /* ============================================================== */
  /* HTMLMediaElement-style properties                                */
  /* ============================================================== */

  /** Current playback position in seconds, sourced from rendered video frame. */
  get currentTime() {
    if (this._lastRenderedFramePtsSec !== null) {
      return this._lastRenderedFramePtsSec + this._seekBaseTime;
    }
    return this._seekBaseTime || 0;
  }

  set currentTime(t) {
    const sec = +t || 0;
    void this.seek(sec);
  }

  /** Total duration in seconds (from playlist), or Infinity for live. */
  get duration() {
    if (this._currentMode === "live" && !this._totalDuration) {
      return Infinity;
    }
    return this._totalDuration || 0;
  }

  get muted() {
    return this._muted;
  }
  set muted(v) {
    const next = !!v;
    if (next === this._muted) return;
    this._muted = next;
    this.audio.setMuted(this._muted);
    this.#emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  get volume() {
    return this._volume;
  }
  set volume(v) {
    const clamped = Math.max(0, Math.min(1, +v || 0));
    if (clamped === this._volume) return;
    this._volume = clamped;
    this.audio.setVolume(clamped);
    this.#emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  get playbackRate() {
    return this._playbackRate;
  }
  set playbackRate(r) {
    const clamped = Math.max(0.25, Math.min(4, +r || 1));
    if (clamped === this._playbackRate) return;
    this._playbackRate = clamped;
    this.audio.setPlaybackRate(clamped);
    this.#emit("ratechange", { playbackRate: this._playbackRate });
  }

  /** True once VOD playback has reached the end of the playlist timeline. */
  get ended() {
    return this._ended;
  }

  get paused() {
    return this._paused;
  }

  /**
   * TimeRanges of buffered media, mimicking HTMLMediaElement.buffered.
   * Approximation: [currentTime, currentTime + audioBuffered + videoLead].
   */
  get buffered() {
    const cur = this.currentTime;
    const audioAhead = this.audio.getBufferedSeconds();
    const videoAhead = this.#getVideoLeadSec();
    const ahead = Math.max(audioAhead, videoAhead);
    if (ahead <= 0 && this.videoQueue.length === 0) {
      return new TimeRangesLite([]);
    }
    return new TimeRangesLite([[cur, cur + ahead]]);
  }

  /* ============================================================== */
  /* Lifecycle                                                       */
  /* ============================================================== */

  async init() {
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = (async () => {
      await this.audio.init();
      this.audio.setVolume(this._volume);
      this.audio.setMuted(this._muted);
      this.audio.setPlaybackRate(this._playbackRate);

      await this.wasm.init({
        onVideoFrame: (width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs, isKeyFrame, codecName, yData, uData, vData) => {
          const y = yData;
          const u = uData;
          const v = vData;
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

          this.#logSegmentVideoInfo(width, height, yStride, uStride, vStride, normalizedPtsMs, codecName);
        },
        onAudioFrame: (channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName, pcmData) => {
          const pcm = pcmData;
          const normalizedPtsMs = this.#normalizeAudioPts(ptsMs, sampleCount, sampleRate);
          this.audio.enqueueFrame({
            channels,
            sampleRate,
            sampleCount,
            pcm,
            ptsMs: normalizedPtsMs,
          });

          this.#logSegmentAudioInfo(channels, sampleRate, sampleCount, normalizedPtsMs, codecName);
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
      throw new Error("WASM player has not been initialized. Call init() first.");
    }

    if (this.running) {
      await this.stop();
    }

    this._currentSrc = url;
    this._currentMode = mode || "vod";
    this._ended = false;
    this._paused = false;
    this._loadedMetadataFired = false;
    this._playingFired = false;
    this._waitingFired = false;
    this._lastDurationFired = -1;
    this._lastEmittedTimeSec = -1;
    this._audioTrackWarned = false;

    this.#emit("loadstart", { src: url, mode: this._currentMode });

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
    this._lastRenderedFramePtsSec = null;
    this._seekBaseTime = 0;

    this.#startRenderLoop();

    this.hls = new HlsController({
      mode: this._currentMode,
      lowLatency: true,
      onDuration: (dur) => {
        const prev = this._totalDuration;
        this._totalDuration = dur;
        if (dur !== prev) {
          this.#emit("durationchange", { duration: this.duration });
        }
        if (!this._loadedMetadataFired) {
          this._loadedMetadataFired = true;
          this.#emit("loadedmetadata", {
            duration: this.duration,
            width: this.canvas?.width,
            height: this.canvas?.height,
          });
        }
      },
      onError: (err) => {
        this.#emit("error", {
          message: err?.message || String(err),
          error: err,
        });
      },
      onSegment: async (bytes, isInitSegment, segmentUrl, trackKind) => {
        await this.#waitForFlowControl();
        // For now the WASM bridge consumes a single muxed/video stream.
        // In master mode we drop standalone audio segments rather than feed
        // them into the wrong demuxer; player.js can be extended later to
        // route trackKind === "audio" into a separate decoding pipeline.
        if (trackKind === "audio") {
          if (!this._audioTrackWarned) {
            this._audioTrackWarned = true;
            this.log("[hls] master playlist has a separate audio rendition; " + "audio chunklist segments are not yet routed into the decoder.");
          }
          return;
        }
        if (!isInitSegment) {
          this.#beginSegmentInfo(segmentUrl, bytes.length);
        }
        this.wasm.feedSegment(bytes, isInitSegment);
        this.log(`${isInitSegment ? "init" : "seg"}: ${segmentUrl}`);
      },
    });

    this.log(`Start ${this._currentMode} playback: ${url}`);
    this.hls.start(url);
    this.#startTimeUpdate();
  }

  async stop() {
    const wasRunning = this.running;
    this.running = false;
    this._paused = true;
    this.#stopTimeUpdate();

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
    this._lastRenderedFramePtsSec = null;

    this.wasm.reset();
    this.audio.reset();
    if (wasRunning) {
      this.#emit("abort", {});
    }
    this.log("Playback stopped.");
  }

  async destroy() {
    await this.stop();
    this.wasm.destroy();
    this._initialized = false;
    this._initPromise = null;
  }

  /** Seek to a target time (seconds). */
  async seek(timeSec) {
    if (!this.running || !this.hls) {
      this.log("Cannot seek: not playing.");
      return;
    }
    this.log(`Seeking to ${timeSec.toFixed(1)}s`);

    this._ended = false;
    this.#emit("seeking", { target: timeSec });

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
    this._lastRenderedFramePtsSec = null;

    const segmentStart = await this.hls.seekTo(timeSec);
    this._seekBaseTime = segmentStart;
    this._playingFired = false; // re-fire playing once first frame after seek renders
    this.log(`Seek done, segment starts at ${segmentStart.toFixed(1)}s`);
    this.#emit("seeked", { currentTime: this.currentTime });
  }

  /* ============================================================== */
  /* HTMLMediaElement-style methods                                  */
  /* ============================================================== */

  /** Resume playback. If never started, this is a no-op (use `start()` first). */
  async play() {
    if (!this.hls) {
      // Mirror HTMLMediaElement: play() on an unloaded element is a no-op
      // (we don't auto-load because we don't know what URL to use).
      this.log("play() ignored: no media loaded. Call start(url, mode) first.");
      return;
    }
    if (!this._paused) return;
    this._paused = false;
    this.running = true;
    this._playingFired = false;
    if (!this.renderRafId) {
      this.#startRenderLoop();
    }
    this.#startTimeUpdate();
    await this.audio.resume();
  }

  /** Pause playback (audio + render loop), keep buffers and HLS state. */
  async pause() {
    if (this._paused) return;
    this._paused = true;
    this.running = false;
    if (this.renderRafId) {
      cancelAnimationFrame(this.renderRafId);
      this.renderRafId = 0;
    }
    this.#stopTimeUpdate();
    await this.audio.suspend();
  }

  /** Reload the current source. Equivalent to stop() + start(currentSrc). */
  async load() {
    if (!this._currentSrc) {
      this.log("load() ignored: no current source.");
      return;
    }
    const url = this._currentSrc;
    const mode = this._currentMode;
    await this.start(url, mode);
  }

  /* ============================================================== */
  /* Backward-compatible helpers                                     */
  /* ============================================================== */

  getCurrentTime() {
    return this.currentTime;
  }

  getTotalDuration() {
    return this._totalDuration || 0;
  }

  /* ============================================================== */
  /* Internals                                                       */
  /* ============================================================== */

  #maybeFallbackFromLowLatency(msg) {
    if (!this.hls || !this.hls.lowLatency || this.hevcCompatFallbackTriggered) {
      return;
    }

    const text = String(msg || "").toLowerCase();
    const hevcHeaderParseFailed = text.includes("failed to parse header of nalu");
    const hevcInvalidData = text.includes("hevc") && text.includes("invalid data found");

    if (!hevcHeaderParseFailed && !hevcInvalidData) {
      return;
    }

    this.hevcCompatFallbackTriggered = true;
    if (typeof this.hls.setLowLatency === "function") {
      this.hls.setLowLatency(false);
    } else {
      this.hls.lowLatency = false;
    }
    this.log("[compat] HEVC NALU parse warning detected. Switched to segment-only mode.");
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
          this._lastRenderedFramePtsSec = headPtsSec;
          this.#maybeMarkEnded();
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

  #maybeMarkEnded() {
    if (this._currentMode !== "vod") return;
    if (this._ended) return;
    if (!this._totalDuration) return;
    if (this.currentTime >= this._totalDuration - 0.05 && this.videoQueue.length === 0) {
      this._ended = true;
      this._paused = true;
      this.#stopTimeUpdate();
      this.#emit("ended", { currentTime: this.currentTime });
    }
  }

  /* ---------------- timeupdate / playing / waiting ---------------- */

  #startTimeUpdate() {
    this.#stopTimeUpdate();
    this._timeUpdateTimerId = window.setInterval(() => {
      const t = this.currentTime;
      // emit timeupdate when time has actually moved (or first emission)
      if (t !== this._lastEmittedTimeSec) {
        this._lastEmittedTimeSec = t;
        this.#emit("timeupdate", { currentTime: t });
      }
      this.#updatePlayingWaitingState();
    }, 250);
  }

  #stopTimeUpdate() {
    if (this._timeUpdateTimerId) {
      clearInterval(this._timeUpdateTimerId);
      this._timeUpdateTimerId = 0;
    }
  }

  #updatePlayingWaitingState() {
    if (this._paused || this._ended) return;
    const hasFrame = this._lastRenderedFramePtsSec !== null;
    const audioBuffered = this.audio.getBufferedSeconds();
    const videoLead = this.#getVideoLeadSec();
    const starving = hasFrame && audioBuffered <= 0.05 && videoLead <= 0.05 && this.videoQueue.length === 0;

    if (hasFrame && !starving && !this._playingFired) {
      this._playingFired = true;
      this._waitingFired = false;
      this.#emit("playing", { currentTime: this.currentTime });
    } else if (starving && !this._waitingFired) {
      this._waitingFired = true;
      this._playingFired = false;
      this.#emit("waiting", { currentTime: this.currentTime });
    }
  }

  /* ---------------- video render loop helpers ---------------- */

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

  #logSegmentVideoInfo(width, height, yStride, uStride, vStride, ptsMs, codecName) {
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

    this.log(`[seg-info] #${ctx.id} ${this.#shortSegmentName(ctx.segmentUrl)} size=${ctx.byteLength}B ${videoText} ${audioText}`);

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
