export interface HlsWasmPlayerOptions {
    canvas: HTMLCanvasElement;
    wasmJsUrl: string;
    wasmFileUrl: string;
    fetchOptions?: RequestInit;
    lowLatencyMode?: boolean;
    followRedirectUrl?: boolean;
    log?: (message: string) => void;
    onIFrame?: (ptsMs: number) => void;
}
export interface IVideoFrame {
    width: number;
    height: number;
    y: Uint8Array;
    u: Uint8Array;
    v: Uint8Array;
    yStride: number;
    uStride: number;
    vStride: number;
    ptsMs: number;
    isKeyFrame: boolean;
}
export interface IAudioPcmFrame {
    channels: number;
    sampleRate: number;
    sampleCount: number;
    ptsMs: number;
    pcm: Float32Array;
}
export interface ISegmentInfo {
    id: number;
    segmentUrl: string;
    byteLength: number;
    videoInfo: {
        width: number;
        height: number;
        yStride: number;
        uStride: number;
        vStride: number;
        ptsMs: number;
        fps: number;
        codecName: string;
    } | null;
    audioInfo: {
        channels: number;
        sampleRate: number;
        sampleCount: number;
        ptsMs: number;
        codecName: string;
    } | null;
    printed: boolean;
    createdAt: number;
}
/**
 * TrackKind represents the type of media track. "video" is for video-only tracks, "audio" is for audio-only tracks, and "muxed" is for tracks that contain both audio and video data.
 * The HlsController uses this type to manage different tracks in an HLS stream, allowing it to handle them appropriately based on their kind.
 *
 */
export type TrackKind = "video" | "audio" | "muxed";
/**
 */
export interface IM3U8AVTrack {
    kind: TrackKind;
    url: string;
    seen: Set<string>;
    initLoaded: boolean;
    abort: AbortController | null;
    sleepResolve: (() => void) | null;
    running: boolean;
}
export interface HlsControllerOptions {
    mode?: "live" | "vod";
    lowLatencyMode?: boolean;
    followRedirectUrl?: boolean;
    requestInit?: RequestInit | null;
    fetchTimeout?: number;
    onSegment: (bytes: Uint8Array, isInitSegment: boolean, segmentUrl: string, trackKind: TrackKind) => Promise<void> | void;
    onDuration?: (duration: number) => void;
    onError?: (error: unknown) => void;
}
export type HlsControllerOnSegment = (bytes: Uint8Array, isInitSegment: boolean, segmentUrl: string, trackKind: TrackKind) => Promise<void> | void;
export type AttrMap = Record<string, string>;
export interface AudioRendition {
    groupId: string;
    name: string;
    default: boolean;
    language: string | null;
    uri: string | null;
}
export interface MasterVariant {
    bandwidth: number;
    codecs: string;
    resolution: string;
    audioGroup: string | null;
    uri: string;
}
export interface MasterPlaylist {
    variants: MasterVariant[];
    audioGroups: Record<string, AudioRendition[]>;
}
export interface MediaSegment {
    url: string;
    duration: number;
}
export interface MediaPart {
    url: string;
    duration: number;
    independent: boolean;
}
export interface MediaPlaylist {
    targetDuration: number;
    mediaSequence: number;
    partTarget: number | null;
    isEndList: boolean;
    initSegment: string | null;
    segments: MediaSegment[];
    parts: MediaPart[];
    preloadHint: string | null;
}
export interface WasmBridgeOptions {
    wasmJsUrl: string;
    wasmFileUrl: string;
}
export type WasmOnVideoFrame = (width: number, height: number, yPtr: number | null, yStride: number, uPtr: number | null, uStride: number, vPtr: number | null, vStride: number, ptsMs: number, fps: number, isKeyFrame: boolean, codecName: string, yData: Uint8Array, uData: Uint8Array, vData: Uint8Array) => void;
export type WasmOnAudioFrame = (channels: number, sampleRate: number, sampleCount: number, dataPtr: number | null, ptsMs: number, codecName: string, pcmData: Float32Array) => void;
export type WasmOnLog = (level: string, msg: string) => void;
export interface WasmInitCallbacks {
    onVideoFrame: WasmOnVideoFrame;
    onAudioFrame: WasmOnAudioFrame;
    onLog: WasmOnLog;
}
