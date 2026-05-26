import { parseMediaPlaylist } from "./playlist_parser.js";

export class HlsController {
  constructor({ mode = "live", lowLatency = true, onSegment, onDuration, onError }) {
    this.mode = mode;
    this.lowLatency = lowLatency;
    this.onSegment = onSegment;
    this.onDuration = onDuration || (() => {});
    this.onError = onError || (() => {});

    this.abortController = null;
    this.running = false;
    this.playlistUrl = "";
    this.seen = new Set();
    this.initLoaded = false;
    this.totalDuration = 0;

    this._sleepTimer = null;
    this._sleepResolve = null;

    this._onVisible = () => {
      if (document.visibilityState === "visible" && this._sleepResolve) {
        this._sleepResolve();
        this._sleepTimer = null;
        this._sleepResolve = null;
      }
    };
  }

  async start(playlistUrl) {
    this.playlistUrl = playlistUrl;
    this.running = true;
    this.abortController = new AbortController();
    document.addEventListener("visibilitychange", this._onVisible);
    await this._loop();
    document.removeEventListener("visibilitychange", this._onVisible);
  }

  /**
   * Seek to a target time (seconds).
   * Restarts the fetch loop from the segment containing targetTime.
   * Returns the actual segment start time for PTS base correction.
   */
  async seekTo(targetTimeSec) {
    const wasRunning = this.running;
    this._abortLoop();
    if (!wasRunning) return 0;

    this.abortController = new AbortController();

    const text = await this.#fetchText(this.playlistUrl);
    const info = parseMediaPlaylist(text, this.playlistUrl);

    let accumulated = 0;
    for (const seg of info.segments) {
      if (accumulated + seg.duration >= targetTimeSec) break;
      accumulated += seg.duration;
      this.seen.add(seg.url);
    }

    this.initLoaded = false;
    if (targetTimeSec <= 0) this.seen.clear();

    // Start loop in background; return segment start time immediately
    this.running = true;
    document.addEventListener("visibilitychange", this._onVisible);
    this._loop().finally(() => {
      document.removeEventListener("visibilitychange", this._onVisible);
    });

    return accumulated;
  }

  stop() {
    this.running = false;
    this._abortLoop();
    document.removeEventListener("visibilitychange", this._onVisible);
  }

  _abortLoop() {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    if (this._sleepResolve) {
      this._sleepResolve();
      this._sleepTimer = null;
      this._sleepResolve = null;
    }
  }

  async _loop() {
    while (this.running) {
      try {
        const text = await this.#fetchText(this.playlistUrl);
        const info = parseMediaPlaylist(text, this.playlistUrl);

        let durationSum = 0;
        for (const seg of info.segments) durationSum += seg.duration;
        if (durationSum > 0) {
          this.totalDuration = durationSum;
          this.onDuration(durationSum);
        }

        if (info.initSegment && !this.initLoaded) {
          const initData = await this.#fetchBytes(info.initSegment);
          await this.onSegment(initData, true, info.initSegment);
          this.initLoaded = true;
        }

        const candidates = [];
        const useParts = this.lowLatency && info.parts.length > 0;
        if (useParts) {
          for (const part of info.parts) candidates.push(part.url);
        } else {
          for (const seg of info.segments) candidates.push(seg.url);
        }
        if (useParts && info.preloadHint) candidates.push(info.preloadHint);

        for (const url of candidates) {
          if (this.seen.has(url)) continue;
          this.seen.add(url);
          const bytes = await this.#fetchBytes(url);
          await this.onSegment(bytes, false, url);
        }

        if (this.mode === "vod" && info.isEndList) break;

        const reloadMs =
          this.lowLatency && info.partTarget
            ? Math.max(150, info.partTarget * 500)
            : Math.max(500, info.targetDuration * 500);

        await this.#sleep(reloadMs);
      } catch (err) {
        if (!this.running) break;
        console.error("HLS loop error:", err);
        try {
          this.onError(err);
        } catch (_) {
          /* swallow listener errors */
        }
        await this.#sleep(500);
      }
    }
  }

  async #fetchText(url) {
    const resp = await fetch(url, {
      signal: this.abortController.signal,
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    });
    if (!resp.ok) throw new Error(`Failed to fetch playlist: ${resp.status}`);
    return resp.text();
  }

  async #fetchBytes(url) {
    const resp = await fetch(url, {
      signal: this.abortController.signal,
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    });
    if (!resp.ok) throw new Error(`Failed to fetch segment: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  #sleep(ms) {
    return new Promise((resolve) => {
      this._sleepTimer = setTimeout(() => {
        this._sleepTimer = null;
        this._sleepResolve = null;
        resolve();
      }, ms);
      this._sleepResolve = resolve;
    });
  }
}
