/**
 * fmp4_aac — extract raw AAC access units from fragmented-MP4 (CMAF) audio and
 * wrap them in ADTS so the browser's AudioContext.decodeAudioData can decode
 * them reliably.
 *
 * Why not feed fMP4 straight to decodeAudioData?
 * ----------------------------------------------
 * decodeAudioData expects a self-contained file with full sample tables in
 * `moov`. A CMAF init segment has an (effectively) empty `moov` — the samples
 * live in per-fragment `moof/trun + mdat`. Worse, the fragmented `mvhd`/`mdhd`
 * duration is frequently set to 0 or 0xFFFFFFFF ("unknown"), which makes the
 * native decoder try to allocate a gigantic output buffer →
 * "RangeError: Array buffer allocation failed".
 *
 * ADTS, by contrast, is a raw self-describing AAC stream that decodeAudioData
 * (Chrome/Firefox) decodes frame-by-frame without any container metadata.
 */
/** Parsed AudioSpecificConfig fields needed to build ADTS headers. */
export interface AacConfig {
    audioObjectType: number;
    samplingFrequencyIndex: number;
    sampleRate: number;
    channelConfig: number;
}
/** Parse an audio init segment (ftyp+moov) → AacConfig, or null if not AAC. */
export declare function parseAudioInit(initBytes: Uint8Array): AacConfig | null;
/**
 * Convert a CMAF audio media segment (moof+mdat, possibly multiple) into a
 * concatenated ADTS-AAC byte stream decodable by decodeAudioData.
 * Returns null if the segment shape is unexpected.
 */
export declare function fmp4ToAdts(mediaBytes: Uint8Array, cfg: AacConfig): Uint8Array | null;
