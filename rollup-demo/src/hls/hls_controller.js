import { classifyPlaylist, parseMasterPlaylist, parseMediaPlaylist, selectVariantAndAudio } from "./playlist_parser.js";

/**
 * Per-track fetch loop state. Each track ("muxed" | "video" | "audio")
 * carries its own seen-set, init-loaded flag and abort controller.
 */
function makeTrackState(kind, url) {
  return {
    kind,
    url,
    seen: new Set(),
    initLoaded: false,
    abort: null,
    sleepResolve: null,
    running: false,
  };
}

export class HlsController {
  constructor({ mode = "live", lowLatency = true, followRedirectUrl = true, onSegment, onDuration, onError }) {
    this.mode = mode;
    this.lowLatency = lowLatency;
    this.followRedirectUrl = followRedirectUrl;
    this.onSegment = onSegment;
    this.onDuration = onDuration || (() => {});
    this.onError = onError || (() => {});

    this.playlistUrl = "";
    this.originPlaylistUrl = "";
    this.totalDuration = 0;

    // Master / media flag chosen at start().
    this.isMaster = false;
    this.tracks = []; // array of track states; one entry in media mode, two in master mode

    this._onVisible = () => {
      if (document.visibilityState === "visible") {
        for (const t of this.tracks) {
          if (t.sleepResolve) {
            t.sleepResolve();
            t.sleepResolve = null;
          }
        }
      }
    };
  }

  /* -------------------- public lifecycle -------------------- */

  async start(playlistUrl) {
    this.playlistUrl = playlistUrl;
    this.originPlaylistUrl = playlistUrl;
    document.addEventListener("visibilitychange", this._onVisible);

    let firstText;
    try {
      firstText = await this._fetchTextDirect(this.playlistUrl);
    } catch (err) {
      try {
        this.onError(err);
      } catch (_) {
        /* ignore */
      }
      document.removeEventListener("visibilitychange", this._onVisible);
      return;
    }

    const kind = classifyPlaylist(firstText);

    if (kind === "master") {
      this.isMaster = true;
      const master = parseMasterPlaylist(firstText, this.playlistUrl);
      const { variant, audio } = selectVariantAndAudio(master);
      if (!variant) {
        const err = new Error("Master playlist has no variants");
        try {
          this.onError(err);
        } catch (_) {
          /* ignore */
        }
        document.removeEventListener("visibilitychange", this._onVisible);
        return;
      }
      console.log(`[hls] master playlist resolved: video=${variant.uri}` + (audio?.uri ? ` audio=${audio.uri}` : " audio=<none>"));
      const videoTrack = makeTrackState("video", variant.uri);
      this.tracks.push(videoTrack);
      const audioTrack = audio?.uri ? makeTrackState("audio", audio.uri) : null;
      if (audioTrack) this.tracks.push(audioTrack);

      const loops = this.tracks.map((t) => this._loop(t));
      await Promise.all(loops);
    } else {
      this.isMaster = false;
      const muxedTrack = makeTrackState("muxed", this.playlistUrl);
      this.tracks.push(muxedTrack);
      await this._loop(muxedTrack);
    }

    document.removeEventListener("visibilitychange", this._onVisible);
  }

  /**
   * Seek to a target time (seconds).
   * Restarts every track loop from its corresponding segment.
   * Returns the segment start time computed for the primary (video / muxed) track.
   */
  async seekTo(targetTimeSec) {
    if (this.tracks.length === 0) return 0;

    // Stop all loops first.
    for (const t of this.tracks) this._abortTrack(t);

    let primaryStart = 0;
    const restarts = [];

    for (const t of this.tracks) {
      const isPrimary = t.kind === "video" || t.kind === "muxed";
      const text = await this._fetchTextDirect(t.url);

      console.warn("seekTo");

      const info = parseMediaPlaylist(text, t.url);

      let accumulated = 0;
      t.seen = new Set();
      for (const seg of info.segments) {
        if (accumulated + seg.duration >= targetTimeSec) break;
        accumulated += seg.duration;
        t.seen.add(seg.url);
      }
      t.initLoaded = false;
      if (targetTimeSec <= 0) t.seen.clear();

      if (isPrimary) primaryStart = accumulated;

      // Resume in background.
      restarts.push(this._loop(t));
    }

    // Don't wait — return primaryStart immediately so the player can rebase PTS.
    Promise.all(restarts).catch(() => {});
    return primaryStart;
  }

  stop() {
    for (const t of this.tracks) this._abortTrack(t);
    this.tracks.length = 0;
    document.removeEventListener("visibilitychange", this._onVisible);
  }

  setLowLatency(value) {
    this.lowLatency = !!value;
  }

  /* -------------------- internals -------------------- */

  _abortTrack(track) {
    track.running = false;
    if (track.abort) {
      track.abort.abort();
      track.abort = null;
    }
    if (track.sleepResolve) {
      track.sleepResolve();
      track.sleepResolve = null;
    }
  }

  async _loop(track) {
    track.running = true;
    track.abort = new AbortController();

    while (track.running) {
      try {
        const text = await this._fetchText(track.url, track.abort.signal);
        const info = parseMediaPlaylist(text, track.url);

        // Duration reporting: only the primary (video / muxed) track drives onDuration.
        if (track.kind === "video" || track.kind === "muxed") {
          let durationSum = 0;
          for (const seg of info.segments) durationSum += seg.duration;
          if (durationSum > 0) {
            this.totalDuration = durationSum;
            this.onDuration(durationSum);
          }
        }

        if (info.initSegment && !track.initLoaded) {
          const initData = await this._fetchBytes(info.initSegment, track.abort.signal);
          await this.onSegment(initData, true, info.initSegment, track.kind);
          track.initLoaded = true;
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
          if (track.seen.has(url)) continue;
          track.seen.add(url);
          const bytes = await this._fetchBytes(url, track.abort.signal);
          await this.onSegment(bytes, false, url, track.kind);
        }

        if (this.mode === "vod" && info.isEndList) break;

        const reloadMs = this.lowLatency && info.partTarget ? Math.max(150, info.partTarget * 500) : Math.max(500, info.targetDuration * 500);

        await this._sleep(track, reloadMs);
      } catch (err) {
        if (!track.running) break;
        console.error(`HLS loop error [${track.kind}]:`, err);
        try {
          this.onError(err);
        } catch (_) {
          /* ignore */
        }
        await this._sleep(track, 500);
      }
    }
  }

  async _fetchText(url, signal) {
    const resp = await fetch(url, {
      signal,
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    });

    console.warn("_fetchText");

    if (!resp.ok) throw new Error(`Failed to fetch playlist: ${resp.status}`);
    return resp.text();
  }

  /** Fetch playlist text without binding to a per-track AbortController. */
  async _fetchTextDirect(url) {
    const resp = await fetch(url, {
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    });

    if (this.followRedirectUrl && resp?.url !== url) {
      console.warn(`Playlist URL redirected: ${this.playlistUrl} → ${resp.url}`);
      this.playlistUrl = resp?.url;
    }
    if (!resp.ok) throw new Error(`Failed to fetch playlist: ${resp.status}`);
    return resp.text();
  }

  async _fetchBytes(url, signal) {
    const resp = await fetch(url, {
      signal,
      cache: "no-store",
      mode: "cors",
      credentials: "omit",
    });
    if (!resp.ok) throw new Error(`Failed to fetch segment: ${resp.status}`);
    return new Uint8Array(await resp.arrayBuffer());
  }

  _sleep(track, ms) {
    return new Promise((resolve) => {
      const id = setTimeout(() => {
        track.sleepResolve = null;
        resolve();
      }, ms);
      track.sleepResolve = () => {
        clearTimeout(id);
        track.sleepResolve = null;
        resolve();
      };
    });
  }
}
