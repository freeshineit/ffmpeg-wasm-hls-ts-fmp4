/* eslint-disable no-unused-vars */
import { classifyPlaylist, parseMasterPlaylist, parseMediaPlaylist, selectVariantAndAudio } from "./playlist_parser";
import Helper from "../utils/helper";
import Fetcher from "../network/fetcher";
import type { TrackState, HlsControllerOptions, HlsControllerOnSegment } from "../types";

export class HlsController {
  /**
   * @param {object} opts
   * @param {"live"|"vod"} [opts.mode]
   * @param {boolean} [opts.lowLatencyMode]
   * @param {boolean} [opts.followRedirectUrl]
   * @param {RequestInit} [opts.requestInit] Custom RequestInit merged into every fetch.
   * @param {number} [opts.fetchTimeout] Per-request timeout in ms (default 30000).
   * @param {Function} opts.onSegment
   * @param {Function} [opts.onDuration]
   * @param {Function} [opts.onError]
   */
  mode: "live" | "vod";
  lowLatencyMode: boolean;
  followRedirectUrl: boolean;
  fetcher: Fetcher;
  onSegment: HlsControllerOnSegment;
  onDuration: (duration: number) => void;
  onError: (error: unknown) => void;

  playlistUrl: string;
  originPlaylistUrl: string;
  totalDuration: number;

  isMaster: boolean;
  tracks: TrackState[];
  _onVisible: () => void;

  constructor({ mode = "live", lowLatencyMode = true, followRedirectUrl = true, requestInit = null, fetchTimeout = 30000, onSegment, onDuration, onError }: HlsControllerOptions) {
    this.mode = mode;
    this.lowLatencyMode = lowLatencyMode;
    this.followRedirectUrl = followRedirectUrl;
    this.fetcher = new Fetcher(requestInit || {}, fetchTimeout);
    this.onSegment = onSegment;
    this.onDuration = onDuration || (() => {});
    this.onError = onError || (() => {});

    this.playlistUrl = "";
    this.originPlaylistUrl = "";
    this.totalDuration = 0;

    this.isMaster = false;
    this.tracks = [];

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

  async start(playlistUrl: string): Promise<void> {
    this.playlistUrl = playlistUrl;
    this.originPlaylistUrl = playlistUrl;
    document.addEventListener("visibilitychange", this._onVisible);

    let firstText;
    try {
      const result = await this.fetcher.fetchText(this.playlistUrl);
      firstText = result.text;
      if (this.followRedirectUrl && result.url !== this.playlistUrl) {
        console.warn(`[hls] Playlist URL redirected: ${this.playlistUrl} → ${result.url}`);
        this.playlistUrl = result.url;
      }
    } catch (err) {
      try {
        this.onError(err);
      } catch (_e) {
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
        } catch (_e) {
          /* ignore */
        }
        document.removeEventListener("visibilitychange", this._onVisible);
        return;
      }
      console.warn(`[hls] master playlist resolved: video=${variant.uri}` + (audio?.uri ? ` audio=${audio.uri}` : " audio=<none>"));
      const videoTrack = Helper.makeTrackState("video", variant.uri) as TrackState;
      this.tracks.push(videoTrack);
      if (audio?.uri) {
        this.tracks.push(Helper.makeTrackState("audio", audio.uri) as TrackState);
      }
      await Promise.all(this.tracks.map((t) => this._loop(t)));
    } else {
      this.isMaster = false;
      const muxedTrack = Helper.makeTrackState("muxed", this.playlistUrl) as TrackState;
      this.tracks.push(muxedTrack);
      await this._loop(muxedTrack);
    }

    document.removeEventListener("visibilitychange", this._onVisible);
  }

  async seekTo(targetTimeSec: number): Promise<number> {
    if (this.tracks.length === 0) return 0;

    for (const t of this.tracks) this._abortTrack(t);

    let primaryStart = 0;
    const restarts = [];

    for (const t of this.tracks) {
      const isPrimary = t.kind === "video" || t.kind === "muxed";
      const result = await this.fetcher.fetchText(t.url);
      const info = parseMediaPlaylist(result.text, t.url);

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

      restarts.push(this._loop(t));
    }

    Promise.all(restarts).catch(() => {});
    return primaryStart;
  }

  stop(): void {
    for (const t of this.tracks) this._abortTrack(t);
    this.tracks.length = 0;
    this.fetcher.cancelAll();
    document.removeEventListener("visibilitychange", this._onVisible);
  }

  setLowLatencyMode(value: boolean): void {
    this.lowLatencyMode = !!value;
  }

  /** Update the base RequestInit used for all subsequent fetches. */
  setRequestInit(requestInit: RequestInit): void {
    this.fetcher.setFetchOptions(requestInit || {});
  }

  /** Merge additional options into the existing fetch config. */
  updateRequestInit(options: RequestInit): void {
    this.fetcher.setFetchOptions(options || {});
  }

  /* -------------------- internals -------------------- */

  _abortTrack(track: TrackState): void {
    track.running = false;
    if (track.url) {
      this.fetcher.cancelRequest(track.url);
    }
    if (track.sleepResolve) {
      track.sleepResolve();
      track.sleepResolve = null;
    }
  }

  async _loop(track: TrackState): Promise<void> {
    track.running = true;

    while (track.running) {
      try {
        const result = await this.fetcher.fetchText(track.url);
        const info = parseMediaPlaylist(result.text, track.url);

        if (track.kind === "video" || track.kind === "muxed") {
          let durationSum = 0;
          for (const seg of info.segments) durationSum += seg.duration;
          if (durationSum > 0) {
            this.totalDuration = durationSum;
            this.onDuration(durationSum);
          }
        }

        if (info.initSegment && !track.initLoaded) {
          const initData = await this.fetcher.fetchBytes(info.initSegment);
          await this.onSegment(initData, true, info.initSegment, track.kind);
          track.initLoaded = true;
        }

        const candidates: string[] = [];
        const useParts = this.lowLatencyMode && info.parts.length > 0;
        if (useParts) {
          for (const part of info.parts) candidates.push(part.url);
        } else {
          for (const seg of info.segments) candidates.push(seg.url);
        }
        if (useParts && info.preloadHint) candidates.push(info.preloadHint);

        for (const url of candidates) {
          if (track.seen.has(url)) continue;
          track.seen.add(url);
          const bytes = await this.fetcher.fetchBytes(url);
          await this.onSegment(bytes, false, url, track.kind);
        }

        if (this.mode === "vod" && info.isEndList) break;

        const reloadMs = this.lowLatencyMode && info.partTarget ? Math.max(150, info.partTarget * 500) : Math.max(500, info.targetDuration * 500);
        await this._sleep(track, reloadMs);
      } catch (err) {
        if (!track.running) break;
        console.error(`[hls] loop error [${track.kind}]:`, err);
        try {
          this.onError(err);
        } catch (_e) {
          /* ignore */
        }
        await this._sleep(track, 500);
      }
    }
  }

  _sleep(track: TrackState, ms: number): Promise<void> {
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
