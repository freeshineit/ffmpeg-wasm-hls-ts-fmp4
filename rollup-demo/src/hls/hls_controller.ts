/* eslint-disable no-unused-vars */
import { classifyPlaylist, parseMasterPlaylist, parseMediaPlaylist, selectVariantAndAudio } from "./playlist_parser";
import Helper from "../utils/helper";
import Fetcher from "../network/fetcher";
import type { IM3U8AVTrack, HlsControllerOptions, HlsControllerOnSegment, MediaPlaylist } from "../types";

export class HlsController {
  playlistType: "live" | "vod" | undefined;
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
  tracks: IM3U8AVTrack[];

  // private
  _getMapCount: number = 0;

  /** 防止多 #EXT-X-MAP:URI= */
  mapList = new Map();

  _onVisible: () => void;
  // PRELOAD-HINT often points to a not-yet-complete object. Fetching and
  // feeding it as a normal segment can inject truncated media into demux.
  enablePreloadHintFetch: boolean;

  constructor({ lowLatencyMode = true, followRedirectUrl = true, requestInit = null, fetchTimeout = 30000, onSegment, onDuration, onError }: HlsControllerOptions) {
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
    this.enablePreloadHintFetch = false;

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
    this._getMapCount = 0;
    this.mapList = new Map();
    document.addEventListener("visibilitychange", this._onVisible);

    let firstText;
    try {
      const result = await this.fetcher.fetchText(this.playlistUrl);
      firstText = result.text;
      // 重定向
      if (this.followRedirectUrl && result.url !== this.playlistUrl) {
        this.playlistUrl = result.url;
      }
    } catch (err) {
      this.onError(err);
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
        this.onError(err);
        document.removeEventListener("visibilitychange", this._onVisible);
        return;
      }
      console.warn(`[hls] master playlist resolved: video=${variant.uri}` + (audio?.uri ? ` audio=${audio.uri}` : " audio=<none>"));
      const videoTrack = Helper.makeTrackState("video", variant.uri) as IM3U8AVTrack;
      this.tracks.push(videoTrack);
      if (audio?.uri) {
        this.tracks.push(Helper.makeTrackState("audio", audio.uri) as IM3U8AVTrack);
      }
      await Promise.all(this.tracks.map((t) => this._loop(t)));
    } else {
      this.isMaster = false;
      this.playlistType = Helper.getPlaylistType(firstText);
      const muxedTrack = Helper.makeTrackState("muxed", this.playlistUrl) as IM3U8AVTrack;
      this.tracks.push(muxedTrack);

      if (this.playlistType === "vod") {
        await this._getPartOrSegmentOrPreloadHint(firstText, muxedTrack);
      } else {
        await this._loop(muxedTrack);
      }
    }

    document.removeEventListener("visibilitychange", this._onVisible);
  }

  async seek(targetTimeSec: number): Promise<number> {
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

  /* -------------------- internals -------------------- */

  _abortTrack(track: IM3U8AVTrack): void {
    track.running = false;
    if (track.url) {
      this.fetcher.cancelRequest(track.url);
    }
    if (track.sleepResolve) {
      track.sleepResolve();
      track.sleepResolve = null;
    }
  }

  async _loop(track: IM3U8AVTrack): Promise<void> {
    track.running = true;

    while (track.running) {
      try {
        const result = await this.fetcher.fetchText(track.url);
        const info = await this._getPartOrSegmentOrPreloadHint(result.text, track);
        if (this.playlistType === "vod" && info.isEndList) break;
        const reloadMs = this.lowLatencyMode && info.partTarget ? Math.max(150, info.partTarget * 500) : Math.max(500, info.targetDuration * 500);
        await this._sleep(track, reloadMs);
      } catch (err) {
        if (!track.running) break;
        console.error(`[hls] loop error [${track.kind}]:`, err);
        this.onError(err);
        await this._sleep(track, 500);
      }
    }
  }

  /**
   * 支持多个 MAP URI 的情况，虽然不太常见
   *
   * fMP4 格式的 HLS 播放 list 必须有 #EXT-X-MAP:URI=...，播放器必须先下载并加载该初始化段，后续所有 media segment 是基于此解码的
   * @param info
   * @param track
   */
  async _getMap(info: MediaPlaylist, track: IM3U8AVTrack): Promise<boolean> {
    const map = this.mapList.get(info.initSegment || "");
    if ((!map || !map?.loaded) && info.initSegment) {
      this._getMapCount++;
      try {
        const initData = await this.fetcher.fetchBytes(info.initSegment);
        this.mapList.set(info.initSegment, { loaded: true, data: initData });
        await this.onSegment(initData, true, info.initSegment, track.kind);
        return true;
      } catch (err) {
        // 不加延时重试，避免 init segment 获取失败导致后续 segment 也无法获取
        // 重试 3 次后放弃，避免死循环
        if (this._getMapCount <= 3) {
          return this._getMap(info, track);
        } else {
          console.error(`[hls] failed to fetch init segment after 3 attempts: ${info.initSegment}`);
          this.onError(err);
          return false;
        }
      }
    }
    return true;
  }

  async _getPartOrSegmentOrPreloadHint(text: string, track: IM3U8AVTrack): Promise<MediaPlaylist> {
    //
    const info = parseMediaPlaylist(text, track.url);

    if (track.kind === "video" || track.kind === "muxed") {
      this.playlistType = Helper.getPlaylistType(text);
    }

    const mapResult = await this._getMap(info, track);
    // 获取 init segment 失败，且重试达到上限，放弃继续获取该 track
    if (mapResult === false) throw new Error(`Failed to fetch init segment: ${info.initSegment}`);

    // url(part or segment) list
    const candidates: string[] = [];
    const shouldCountDuration = track.kind === "video" || track.kind === "muxed";
    const useParts = this.lowLatencyMode && info.parts.length > 0;
    if (useParts) {
      for (const part of info.parts) {
        candidates.push(part.url);
        if (track.seen.has(part.url)) continue;
        if (shouldCountDuration && part.duration > 0) {
          this.totalDuration += part.duration;
          this.onDuration(this.totalDuration);
        }
      }
    } else {
      for (const seg of info.segments) {
        candidates.push(seg.url);
        if (track.seen.has(seg.url)) continue;
        if (shouldCountDuration && seg.duration > 0) {
          this.totalDuration += seg.duration;
          this.onDuration(this.totalDuration);
        }
      }
    }
    if (this.enablePreloadHintFetch && useParts && info.preloadHint) candidates.push(info.preloadHint);

    for (const url of candidates) {
      if (track.seen.has(url)) continue;
      track.seen.add(url);
      try {
        const bytes = await this.fetcher.fetchBytes(url);
        await this.onSegment(bytes, false, url, track.kind);
      } catch (error) {
        console.error(`[hls] failed to fetch segment: ${url}`, error);
        this.onError(error);
      }
    }
    return info;
  }

  _sleep(track: IM3U8AVTrack, ms: number): Promise<void> {
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
