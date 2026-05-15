import { parseMediaPlaylist } from "./playlist_parser.js";

export class HlsController {
  constructor({ mode = "live", lowLatency = true, allowPreloadHint = false, onSegment }) {
    this.mode = mode;
    this.lowLatency = lowLatency;
    this.allowPreloadHint = allowPreloadHint;
    this.onSegment = onSegment;

    this.abortController = null;
    this.running = false;
    this.playlistUrl = "";
    this.seen = new Set();
    this.initLoaded = false;
  }

  async start(playlistUrl) {
    this.playlistUrl = playlistUrl;
    this.running = true;
    this.abortController = new AbortController();

    while (this.running) {
      try {
        const text = await this.#fetchText(this.playlistUrl);
        const info = parseMediaPlaylist(text, this.playlistUrl);

        if (info.initSegment && !this.initLoaded) {
          const initData = await this.#fetchBytes(info.initSegment);
          await this.onSegment(initData, true, info.initSegment);
          this.initLoaded = true;
        }

        const candidates = [];
        const useParts = this.lowLatency && info.parts.length > 0;

        if (useParts) {
          for (const part of info.parts) {
            candidates.push(part.url);
          }
        } else {
          for (const seg of info.segments) {
            candidates.push(seg.url);
          }
        }

        if (useParts && this.allowPreloadHint && info.preloadHint) {
          candidates.push(info.preloadHint);
        }

        for (const url of candidates) {
          if (this.seen.has(url)) {
            continue;
          }
          this.seen.add(url);
          const bytes = await this.#fetchBytes(url);
          await this.onSegment(bytes, false, url);
        }

        if (this.mode === "vod" && info.isEndList) {
          break;
        }

        const reloadMs = this.lowLatency && info.partTarget
          ? Math.max(150, info.partTarget * 500)
          : Math.max(500, info.targetDuration * 500);

        await this.#sleep(reloadMs);
      } catch (err) {
        if (!this.running) {
          break;
        }
        console.error("HLS loop error:", err);
        await this.#sleep(500);
      }
    }
  }

  stop() {
    this.running = false;
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.seen.clear();
    this.initLoaded = false;
  }

  setLowLatency(enabled, { clearSeen = false } = {}) {
    const next = Boolean(enabled);
    if (this.lowLatency === next) {
      return;
    }

    this.lowLatency = next;
    if (clearSeen) {
      this.seen.clear();
    }
  }

  async #fetchText(url) {
    const resp = await fetch(url, {
      signal: this.abortController.signal,
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch playlist: ${resp.status}`);
    }
    return resp.text();
  }

  async #fetchBytes(url) {
    const resp = await fetch(url, {
      signal: this.abortController.signal,
      cache: "no-store",
    });
    if (!resp.ok) {
      throw new Error(`Failed to fetch segment: ${resp.status}`);
    }
    return new Uint8Array(await resp.arrayBuffer());
  }

  #sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
