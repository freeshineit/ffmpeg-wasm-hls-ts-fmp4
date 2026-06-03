/**
 * Mp4AudioDecoder — decodes a standalone fMP4 / CMAF AAC audio track using the
 * browser's native `AudioContext.decodeAudioData`, without a second WASM
 * decoder.
 *
 * Approach
 * --------
 * We do NOT feed fragmented MP4 to decodeAudioData (its `moov` has no sample
 * table and the fragmented duration is often "unknown", which makes the native
 * decoder attempt a huge output allocation → "Array buffer allocation failed").
 *
 * Instead we:
 *   1. Parse the audio init segment once to recover the AAC config
 *      (AudioObjectType, sample rate, channel count) from `esds`.
 *   2. For each media segment, walk `moof/trun` to get per-sample sizes, slice
 *      the raw AAC access units out of `mdat`, and wrap each in an ADTS header.
 *   3. Hand the concatenated ADTS stream to decodeAudioData, which decodes
 *      self-describing ADTS reliably and allocates a correctly-sized buffer.
 *
 * PTS is derived by accumulating decoded durations from the first segment;
 * CMAF keeps audio and video timelines aligned, so this monotonic clock tracks
 * the video PTS closely enough for A/V sync (the AudioRenderer then schedules
 * buffers gaplessly).
 */
import { type AacConfig } from "./fmp4_aac";
export interface DecodedPcmFrame {
    channels: number;
    sampleRate: number;
    sampleCount: number;
    pcm: Float32Array;
    ptsMs: number;
}
export declare class Mp4AudioDecoder {
    audioContext: AudioContext | null;
    onPcm: (frame: DecodedPcmFrame) => void;
    onError: (error: Error) => void;
    _initSegment: Uint8Array | null;
    _aacConfig: AacConfig | null;
    _timelineSec: number;
    _started: boolean;
    _decodeChain: Promise<void>;
    _disposed: boolean;
    _failCount: number;
    constructor(audioContext: AudioContext | null, onPcm: (frame: DecodedPcmFrame) => void, onError?: (error: Error) => void);
    setAudioContext(audioContext: AudioContext | null): void;
    /** Store + parse the audio init segment (ftyp+moov). */
    setInitSegment(bytes: Uint8Array | ArrayBuffer): void;
    hasInit(): boolean;
    /** Feed one media segment (moof+mdat). Decoding is serialized to keep order. */
    feedSegment(bytes: Uint8Array | ArrayBuffer): Promise<void>;
    _decodeOne(media: Uint8Array): Promise<void>;
    _reportFail(msg: string): void;
    /** Reset the timeline (e.g. on seek) but keep the init/config. */
    reset(): void;
    /** Full reset including init/config (e.g. switching streams). */
    clear(): void;
    dispose(): void;
}
export default Mp4AudioDecoder;
