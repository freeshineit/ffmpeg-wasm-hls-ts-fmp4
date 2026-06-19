import { WebGlRender } from "./renderer/webgl-420p";
import { AudioRenderer } from "./audio/audio_renderer";
import { Mp4AudioDecoder } from "./audio/mp4_audio_decoder";
import { PlaylistManager } from "./playlist";
import { WasmBridge } from "./wasm/wasm_bridge";
import TimeRangesLite from "./utils/TimeRangesLite";
import type { IAudioPcmFrame, ISegmentInfo, HlsWasmPlayerOptions, IVideoFrame } from "./types";
export declare class HlsWasmPlayer {
    #private;
    canvas: HTMLCanvasElement;
    log: (message: string) => void;
    onIFrame: ((ptsMs: number) => void) | undefined;
    _events: EventTarget;
    renderer: WebGlRender;
    audio: AudioRenderer;
    wasm: WasmBridge;
    audioDecoder: Mp4AudioDecoder | null;
    _hasSeparateAudioTrack: boolean;
    _avGateOpen: boolean;
    _pendingAudioFrames: IAudioPcmFrame[];
    _avGateTimer: number;
    playlist: PlaylistManager;
    running: boolean;
    _initPromise: Promise<void> | null;
    _initialized: boolean;
    videoQueue: IVideoFrame[];
    videoClockOffsetSec: number | null;
    renderRafId: number;
    maxVideoQueueSize: number;
    videoQueueHighWatermark: number;
    maxAudioBufferedSec: number;
    maxVideoLeadSec: number;
    dropLateFrameSec: number;
    maxFrameDropsPerTick: number;
    droppedVideoFrames: number;
    lastDropLogAt: number;
    lastVideoRawPtsMs: number | null;
    lastVideoNormPtsMs: number | null;
    videoFrameDurMs: number;
    lastAudioRawPtsMs: number | null;
    lastAudioNormPtsMs: number | null;
    segmentSeq: number;
    segmentInfoQueue: ISegmentInfo[];
    maxPendingSegmentInfo: number;
    maxSegmentInfoAgeMs: number;
    hevcCompatFallbackTriggered: boolean;
    waitingForRecoveryKeyFrame: boolean;
    rejectedVideoFrames: number;
    lastCorruptLogAt: number;
    _totalDuration: number;
    _seekBaseTime: number;
    _currentSrc: string;
    _currentMode: "live" | "vod";
    _paused: boolean;
    _ended: boolean;
    _volume: number;
    _muted: boolean;
    _playbackRate: number;
    _lastRenderedFramePtsSec: number | null;
    _onVisibilityBound: () => void;
    _timeUpdateTimerId: number;
    _lastEmittedTimeSec: number;
    _loadedMetadataFired: boolean;
    _playingFired: boolean;
    _waitingFired: boolean;
    _lastDurationFired: number;
    _audioTrackWarned: boolean;
    constructor({ canvas, wasmJsUrl, wasmFileUrl, log, onIFrame }: HlsWasmPlayerOptions);
    addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
    removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
    dispatchEvent(event: Event): boolean;
    _emit(type: string, detail: unknown): void;
    /** Current playback position in seconds, sourced from rendered video frame. */
    get currentTime(): number;
    set currentTime(t: number);
    /** Total duration in seconds (from playlist), or Infinity for live. */
    get duration(): number;
    get muted(): boolean;
    set muted(v: boolean);
    get volume(): number;
    set volume(v: number);
    get playbackRate(): number;
    set playbackRate(r: number);
    /** True once VOD playback has reached the end of the playlist timeline. */
    get ended(): boolean;
    get paused(): boolean;
    /**
     * TimeRanges of buffered media, mimicking HTMLMediaElement.buffered.
     * Approximation: [currentTime, currentTime + audioBuffered + videoLead].
     */
    get buffered(): TimeRangesLite;
    init(): Promise<void>;
    start(url: string, mode?: "live" | "vod"): Promise<void>;
    stop(): Promise<void>;
    destroy(): Promise<void>;
    /** Seek to a target time (seconds). */
    seek(timeSec: number): Promise<void>;
    /** Resume playback. If never started, this is a no-op (use `start()` first). */
    play(): Promise<void>;
    /** Pause playback (audio + render loop), keep buffers and HLS state. */
    pause(): Promise<void>;
    /** Reload the current source. Equivalent to stop() + start(currentSrc). */
    load(): Promise<void>;
    getCurrentTime(): number;
    getTotalDuration(): number;
    /**
     * Route a decoded audio PCM frame to the renderer, honoring the A/V startup
     * gate. While the gate is closed (master mode, before the first video frame),
     * frames are buffered so the audio clock does not start before video.
     */
    _emitAudioFrame(frame: IAudioPcmFrame): void;
    _waitForFlowControl(): Promise<void>;
    /**
     * Audio-only back-pressure for the standalone audio track. Independent from
     * the video gate so slow video decoding cannot starve audio (and vice
     * versa). Only throttles when the scheduled audio buffer runs ahead.
     */
    _waitForAudioFlowControl(): Promise<void>;
    _beginSegmentInfo(segmentUrl: string, byteLength: number): void;
}
