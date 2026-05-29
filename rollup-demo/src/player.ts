/* eslint-disable no-unused-vars */
import { WebGlRender } from "./renderer/webgl-420p";
import { AudioRenderer } from "./audio/audio_renderer";
import { Mp4AudioDecoder } from "./audio/mp4_audio_decoder";
import { HlsController } from "./hls/hls_controller";
import { WasmBridge } from "./wasm/wasm_bridge";
import TimeRangesLite from "./utils/TimeRangesLite";

interface HlsWasmPlayerOptions {
  canvas: HTMLCanvasElement;
  wasmJsUrl: string;
  wasmFileUrl: string;
  log?: (message: string) => void;
  onIFrame?: (ptsMs: number) => void;
}

export class HlsWasmPlayer {
  [key: string]: any;

  constructor({ canvas, wasmJsUrl, wasmFileUrl, log, onIFrame }: HlsWasmPlayerOptions) {
    this.canvas = canvas;
    this.log = log || (() => {});
    this.onIFrame = onIFrame;

    // Event delegate (HTMLMediaElement-style addEventListener / removeEventListener / dispatchEvent).
    this._events = new EventTarget();

    this.renderer = new WebGlRender(canvas);
    this.audio = new AudioRenderer();
    this.wasm = new WasmBridge({ wasmJsUrl, wasmFileUrl });

    // Standalone audio track (master/multivariant fMP4-AAC) is decoded by the
    // browser via AudioContext.decodeAudioData rather than WASM. Created lazily
    // once the audio AudioContext exists (after init()).
    this.audioDecoder = null;
    // True once a separate "audio" track has been observed for this session.
    this._hasSeparateAudioTrack = false;
    // A/V startup gate: in master mode the native audio decoder is much faster
    // than the WASM video decoder, so audio would start ~1-2s before the first
    // video frame and the render loop would drop all "late" early frames.
    // We hold decoded audio PCM until the first video frame is ready (or a
    // timeout fires for audio-only), so both clocks start at the same instant.
    this._avGateOpen = true;
    this._pendingAudioFrames = [];
    this._avGateTimer = 0;

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
    this.maxFrameDropsPerTick = 10; // prevent massive frame-drop stalls

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
    this.maxSegmentInfoAgeMs = 30_000; // evict entries older than 30s
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

    // Visibility-change handler for tab-background detection
    this._onVisibilityBound = () => this.#onVisibilityChange();

    // Event-emission bookkeeping
    this._timeUpdateTimerId = 0;
    this._lastEmittedTimeSec = -1;
    this._loadedMetadataFired = false;
    this._playingFired = false;
    this._waitingFired = false;
    this._lastDurationFired = -1;
    this._audioTrackWarned = false;
  }

  /* ============================================================== */
  /* Event API (HTMLMediaElement-style)                              */
  /* ============================================================== */

  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void {
    return this._events.addEventListener(type, listener, options);
  }
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void {
    return this._events.removeEventListener(type, listener, options);
  }
  dispatchEvent(event: Event): boolean {
    return this._events.dispatchEvent(event);
  }

  #emit(type: string, detail: unknown): void {
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

  set currentTime(t: number) {
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
  set muted(v: boolean) {
    const next = !!v;
    if (next === this._muted) return;
    this._muted = next;
    this.audio.setMuted(this._muted);
    this.#emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  get volume() {
    return this._volume;
  }
  set volume(v: number) {
    const clamped = Math.max(0, Math.min(1, +v || 0));
    if (clamped === this._volume) return;
    this._volume = clamped;
    this.audio.setVolume(clamped);
    this.#emit("volumechange", { volume: this._volume, muted: this._muted });
  }

  get playbackRate() {
    return this._playbackRate;
  }
  set playbackRate(r: number) {
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

      // Native browser decoder for a standalone fMP4-AAC audio track
      // (master/multivariant playlists). Decoded PCM feeds the same
      // AudioRenderer used by the WASM audio path, so the audio clock and
      // A/V sync logic stay identical regardless of decode source.
      this.audioDecoder = new Mp4AudioDecoder(
        this.audio.audioContext,
        (frame) => {
          this.#emitAudioFrame(frame);
        },
        (err) => {
          this.log(`[audio] ${err.message}`);
        },
      );

      await this.wasm.init({
        onVideoFrame: (
          width: number,
          height: number,
          yPtr: number | null,
          yStride: number,
          uPtr: number | null,
          uStride: number,
          vPtr: number | null,
          vStride: number,
          ptsMs: number,
          isKeyFrame: boolean,
          codecName: string,
          yData: Uint8Array,
          uData: Uint8Array,
          vData: Uint8Array,
        ) => {
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

          // First video frame is ready → release any audio held by the A/V gate
          // so audio and video clocks start together.
          if (!this._avGateOpen) {
            this.#openAvGate();
          }

          this.#logSegmentVideoInfo(width, height, yStride, uStride, vStride, normalizedPtsMs, codecName);
        },
        onAudioFrame: (channels: number, sampleRate: number, sampleCount: number, dataPtr: number | null, ptsMs: number, codecName: string, pcmData: Float32Array) => {
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
        onLog: (level: string, msg: string) => {
          this.log(`[wasm:${level}] ${msg}`);
          this.#maybeFallbackFromLowLatency(msg);
        },
      });

      this._initialized = true;
      this.log("WASM module initialized successfully.");
    })();

    return this._initPromise;
  }

  async start(url: string, mode: "live" | "vod" = "vod") {
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

    // Arm the A/V startup gate: hold decoded audio until the first video
    // frame renders (or the timeout fires). Released in #openAvGate.
    this._avGateOpen = false;
    this._pendingAudioFrames.length = 0;
    if (this._avGateTimer) {
      clearTimeout(this._avGateTimer);
      this._avGateTimer = 0;
    }
    // Fallback: if no video frame arrives (audio-only stream or very slow
    // video), open the gate after 2s so audio is never stuck silent.
    this._avGateTimer = window.setTimeout(() => this.#openAvGate(), 2000);

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

    // Listen for tab background/foreground transitions to
    // prevent massive frame-drop storms when rAF was suspended.
    document.addEventListener("visibilitychange", this._onVisibilityBound);

    this.hls = new HlsController({
      mode: this._currentMode,
      lowLatencyMode: true,
      onDuration: (dur: number) => {
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
      onError: (err: unknown) => {
        this.#emit("error", {
          message: err instanceof Error ? err.message : String(err),
          error: err,
        });
      },
      onSegment: async (bytes: Uint8Array, isInitSegment: boolean, segmentUrl: string, trackKind: "video" | "audio" | "muxed") => {
        // Standalone audio track (master/multivariant): decode via the browser
        // using AudioContext.decodeAudioData rather than the WASM demuxer.
        // Audio uses its OWN flow-control gate (audio buffer only) so a slow
        // video decoder can never starve / block the audio pipeline.
        if (trackKind === "audio") {
          await this.#waitForAudioFlowControl();
          this._hasSeparateAudioTrack = true;
          if (!this.audioDecoder) return;
          if (isInitSegment) {
            this.audioDecoder.setInitSegment(bytes);
            this.log(`audio-init: ${segmentUrl}`);
          } else {
            void this.audioDecoder.feedSegment(bytes);
            this.log(`audio-seg: ${segmentUrl}`);
          }
          return;
        }

        // Video / muxed track → WASM decoder, gated by the full A/V flow control.
        await this.#waitForFlowControl();
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

    document.removeEventListener("visibilitychange", this._onVisibilityBound);

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
    if (this.audioDecoder) this.audioDecoder.clear();
    this._hasSeparateAudioTrack = false;
    this._avGateOpen = true;
    this._pendingAudioFrames.length = 0;
    if (this._avGateTimer) {
      clearTimeout(this._avGateTimer);
      this._avGateTimer = 0;
    }
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
  async seek(timeSec: number) {
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
    if (this.audioDecoder) this.audioDecoder.reset();

    // Re-arm the A/V startup gate so post-seek audio waits for the first
    // decoded video frame again (prevents audio racing ahead after a seek).
    this._avGateOpen = false;
    this._pendingAudioFrames.length = 0;
    if (this._avGateTimer) {
      clearTimeout(this._avGateTimer);
      this._avGateTimer = 0;
    }
    this._avGateTimer = window.setTimeout(() => this.#openAvGate(), 2000);

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

  #maybeFallbackFromLowLatency(msg: string) {
    if (!this.hls || !this.hls.lowLatencyMode || this.hevcCompatFallbackTriggered) {
      return;
    }

    const text = String(msg || "").toLowerCase();
    const hevcHeaderParseFailed = text.includes("failed to parse header of nalu");
    const hevcInvalidData = text.includes("hevc") && text.includes("invalid data found");

    if (!hevcHeaderParseFailed && !hevcInvalidData) {
      return;
    }

    this.hevcCompatFallbackTriggered = true;
    if (typeof this.hls.setLowLatencyMode === "function") {
      this.hls.setLowLatencyMode(false);
    } else {
      this.hls.lowLatencyMode = false;
    }
    this.log("[compat] HEVC NALU parse warning detected. Switched to segment-only mode.");
  }

  #enqueueVideoFrame(frame: { ptsMs: number; width: number; height: number; y: Uint8Array; u: Uint8Array; v: Uint8Array; yStride: number; uStride: number; vStride: number; isKeyFrame: boolean }) {
    if (!Number.isFinite(frame.ptsMs)) {
      return;
    }
    this.videoQueue.push(frame);
  }

  #startRenderLoop() {
    if (this.renderRafId) {
      cancelAnimationFrame(this.renderRafId);
    }

    // For video-only streams (no audio clock) we pace by decoded-frame arrival
    // rather than by wall-clock, so slow software decoding (large HEVC frames,
    // 4K, etc.) doesn't make every-frame "late" and cause a frozen picture.
    let lastRenderWallSec = 0;

    const tick = () => {
      if (!this.running) {
        this.renderRafId = 0;
        return;
      }

      const audioMediaTimeSec = this.audio.getMediaTimeSec();
      const nowSec = performance.now() / 1000;

      if (audioMediaTimeSec !== null) {
        // ---- A/V sync path: drive video by the audio clock ----
        let renderedThisTick = 0;
        let droppedThisTick = 0;
        while (this.videoQueue.length > 0) {
          const head = this.videoQueue[0];
          const headPtsSec = head.ptsMs / 1000;
          const delta = headPtsSec - audioMediaTimeSec;

          if (delta > 0.01) {
            break;
          }

          this.videoQueue.shift();
          if (delta < -this.dropLateFrameSec) {
            if (droppedThisTick >= this.maxFrameDropsPerTick) {
              break;
            }
            this.droppedVideoFrames += 1;
            droppedThisTick += 1;
            continue;
          }
          this.renderer.renderYuv420(head);
          this._lastRenderedFramePtsSec = headPtsSec;
          lastRenderWallSec = nowSec;
          this.#maybeMarkEnded();
          renderedThisTick += 1;
          if (renderedThisTick >= 2) {
            break;
          }
        }
      } else if (this.videoQueue.length > 0) {
        // ---- Video-only path: pace by frame-duration, never drop "late" ----
        // Pull at most one frame per RAF tick, but only after the previous
        // frame has been on screen for at least its PTS-derived duration.
        const minIntervalSec = Math.max(5, this.videoFrameDurMs || 33.33) / 1000;
        if (nowSec - lastRenderWallSec >= minIntervalSec * 0.9) {
          const head = this.videoQueue.shift();
          const headPtsSec = head.ptsMs / 1000;
          this.renderer.renderYuv420(head);
          this._lastRenderedFramePtsSec = headPtsSec;
          lastRenderWallSec = nowSec;
          this.#maybeMarkEnded();
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

  /**
   * Handle tab background → foreground transitions.
   *
   * When the tab is backgrounded the browser suspends requestAnimationFrame,
   * but Web Audio continues to play. This means mediaTimeSec advances while
   * videoQueue accumulates unrendered frames. On return, the accumulated
   * frames would be far behind mediaTimeSec and all be dropped at once.
   *
   * We detect this by checking if the queue exceeded a healthy size and
   * the lead frame is already stale – if so, we fast-forward the video
   * clock and flush the irrecoverable frames so rendering can re-sync
   * smoothly instead of freezing while dropping hundreds of frames.
   */
  #onVisibilityChange() {
    if (document.visibilityState !== "visible") return;
    if (!this.running || this.videoQueue.length === 0) return;

    const mediaTimeSec = this.audio.getMediaTimeSec();
    const headPtsSec = this.videoQueue[0].ptsMs / 1000;

    // If the audio clock has advanced far beyond the oldest queued video
    // frame (e.g. several seconds), the queue is irrecoverably stale.
    // Flush everything behind mediaTime and reset the offset so the
    // render loop doesn't spend ticks doing nothing but dropping frames.
    if (mediaTimeSec !== null && mediaTimeSec - headPtsSec > 1.0) {
      // Drop all frames whose PTS is behind mediaTime.
      while (this.videoQueue.length > 0) {
        const pts = this.videoQueue[0].ptsMs / 1000;
        if (pts >= mediaTimeSec - this.dropLateFrameSec) break;
        this.videoQueue.shift();
        this.droppedVideoFrames += 1;
      }
      this.videoClockOffsetSec = null;
      this.log(`[visibility] flushed stale video frames (${this.videoQueue.length} remaining)`);
    }
  }

  /**
   * Route a decoded audio PCM frame to the renderer, honoring the A/V startup
   * gate. While the gate is closed (master mode, before the first video frame),
   * frames are buffered so the audio clock does not start before video.
   */
  #emitAudioFrame(frame: { channels: number; sampleRate: number; sampleCount: number; ptsMs: number; pcm: Float32Array }) {
    if (!this._avGateOpen) {
      this._pendingAudioFrames.push(frame);
      // Safety cap: don't buffer unbounded audio if video never shows up
      // before the timeout (the timer will open the gate anyway).
      if (this._pendingAudioFrames.length > 400) {
        this._pendingAudioFrames.shift();
      }
      return;
    }
    this.audio.enqueueFrame(frame);
    this.#logSegmentAudioInfo(frame.channels, frame.sampleRate, frame.sampleCount, frame.ptsMs, "aac(native)");
  }

  /** Release buffered audio and let audio/video clocks start together. */
  #openAvGate() {
    if (this._avGateOpen) return;
    this._avGateOpen = true;
    if (this._avGateTimer) {
      clearTimeout(this._avGateTimer);
      this._avGateTimer = 0;
    }
    if (this._pendingAudioFrames.length > 0) {
      const frames = this._pendingAudioFrames;
      this._pendingAudioFrames = [];
      for (const frame of frames) {
        this.audio.enqueueFrame(frame);
        this.#logSegmentAudioInfo(frame.channels, frame.sampleRate, frame.sampleCount, frame.ptsMs, "aac(native)");
      }
    }
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

  /**
   * Audio-only back-pressure for the standalone audio track. Independent from
   * the video gate so slow video decoding cannot starve audio (and vice
   * versa). Only throttles when the scheduled audio buffer runs ahead.
   */
  async #waitForAudioFlowControl() {
    while (this.running) {
      if (this.audio.getBufferedSeconds() <= this.maxAudioBufferedSec) {
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

  #normalizeVideoPts(rawPtsMs: number) {
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

  #normalizeAudioPts(rawPtsMs: number, sampleCount: number, sampleRate: number) {
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

  #beginSegmentInfo(segmentUrl: string, byteLength: number) {
    this.#flushHeadSegmentInfo();

    this.segmentInfoQueue.push({
      id: ++this.segmentSeq,
      segmentUrl,
      byteLength,
      videoInfo: null,
      audioInfo: null,
      printed: false,
      createdAt: Date.now(),
    });

    // Evict entries that exceed the age limit (e.g. single-track streams
    // where one info type never arrives, preventing automatic flush).
    this.#evictStaleSegmentInfos();

    while (this.segmentInfoQueue.length > this.maxPendingSegmentInfo) {
      const stale = this.segmentInfoQueue.shift();
      this.#flushSegmentInfo(stale, true);
    }
  }

  #logSegmentVideoInfo(width: number, height: number, yStride: number, uStride: number, vStride: number, ptsMs: number, codecName: string) {
    const ctx = this.segmentInfoQueue.find((item: any) => !item.videoInfo);
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

  #logSegmentAudioInfo(channels: number, sampleRate: number, sampleCount: number, ptsMs: number, codecName: string) {
    const ctx = this.segmentInfoQueue.find((item: any) => !item.audioInfo);
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

  #flushSegmentInfo(ctx: any, force = false) {
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
    // Evict entries that are both printed AND aged out.
    this.#evictStaleSegmentInfos();

    while (this.segmentInfoQueue.length > 0) {
      const head = this.segmentInfoQueue[0];
      if (!head.printed) {
        break;
      }
      this.segmentInfoQueue.shift();
    }
  }

  /**
   * Force-flush segment info entries that have been pending for too long.
   * This handles edge cases like single-track streams (e.g. video-only)
   * where one info type never arrives, preventing automatic flush via
   * the normal code path.
   */
  #evictStaleSegmentInfos() {
    const now = Date.now();
    while (this.segmentInfoQueue.length > 0) {
      const head = this.segmentInfoQueue[0];
      if (!head.createdAt || now - head.createdAt < this.maxSegmentInfoAgeMs) {
        break;
      }
      this.#flushSegmentInfo(head, true);
      this.segmentInfoQueue.shift();
    }
  }

  #shortSegmentName(segmentUrl: string) {
    try {
      const url = new URL(segmentUrl);
      const parts = url.pathname.split("/");
      return parts[parts.length - 1] || segmentUrl;
    } catch {
      return segmentUrl;
    }
  }
}
