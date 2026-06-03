import Fetcher from "../network/fetcher";
import type { IM3U8AVTrack, HlsControllerOptions, HlsControllerOnSegment, MediaPlaylist } from "../types";
export declare class HlsController {
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
    _getMapCount: number;
    /** 防止多 #EXT-X-MAP:URI= */
    mapList: Map<any, any>;
    _onVisible: () => void;
    constructor({ lowLatencyMode, followRedirectUrl, requestInit, fetchTimeout, onSegment, onDuration, onError }: HlsControllerOptions);
    start(playlistUrl: string): Promise<void>;
    seek(targetTimeSec: number): Promise<number>;
    stop(): void;
    setLowLatencyMode(value: boolean): void;
    /** Update the base RequestInit used for all subsequent fetches. */
    setRequestInit(requestInit: RequestInit): void;
    _abortTrack(track: IM3U8AVTrack): void;
    _loop(track: IM3U8AVTrack): Promise<void>;
    /**
     * 支持多个 MAP URI 的情况，虽然不太常见
     *
     * fMP4 格式的 HLS 播放 list 必须有 #EXT-X-MAP:URI=...，播放器必须先下载并加载该初始化段，后续所有 media segment 是基于此解码的
     * @param info
     * @param track
     */
    _getMap(info: MediaPlaylist, track: IM3U8AVTrack): Promise<boolean>;
    _getPartOrSegmentOrPreloadHint(text: string, track: IM3U8AVTrack): Promise<MediaPlaylist>;
    _sleep(track: IM3U8AVTrack, ms: number): Promise<void>;
}
