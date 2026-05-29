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

import { parseAudioInit, fmp4ToAdts, type AacConfig } from "./fmp4_aac";

export interface DecodedPcmFrame {
  channels: number;
  sampleRate: number;
  sampleCount: number;
  pcm: Float32Array;
  ptsMs: number;
}

export class Mp4AudioDecoder {
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

  constructor(audioContext: AudioContext | null, onPcm: (frame: DecodedPcmFrame) => void, onError?: (error: Error) => void) {
    this.audioContext = audioContext;
    this.onPcm = onPcm;
    this.onError = onError || (() => {});

    /** @type {Uint8Array | null} raw init segment (ftyp+moov). */
    this._initSegment = null;
    /** @type {import("./fmp4_aac").AacConfig | null} */
    this._aacConfig = null;

    this._timelineSec = 0;
    this._started = false;
    this._decodeChain = Promise.resolve();
    this._disposed = false;
    this._failCount = 0;
  }

  setAudioContext(audioContext: AudioContext | null): void {
    this.audioContext = audioContext;
  }

  /** Store + parse the audio init segment (ftyp+moov). */
  setInitSegment(bytes: Uint8Array | ArrayBuffer): void {
    this._initSegment = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    try {
      this._aacConfig = parseAudioInit(this._initSegment);
      if (!this._aacConfig) {
        this.onError(new Error("audio init: not an AAC/mp4a track or esds not found"));
      }
    } catch (err) {
      this._aacConfig = null;
      const msg = err instanceof Error ? err.message : String(err);
      this.onError(new Error(`audio init parse failed: ${msg}`));
    }
  }

  hasInit(): boolean {
    return this._aacConfig !== null;
  }

  /** Feed one media segment (moof+mdat). Decoding is serialized to keep order. */
  feedSegment(bytes: Uint8Array | ArrayBuffer): Promise<void> {
    const media = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    this._decodeChain = this._decodeChain
      .then(() => this._decodeOne(media))
      .catch((err: unknown) => {
        console.error("[mp4-audio] decode failed:", err);
      });
    return this._decodeChain;
  }

  async _decodeOne(media: Uint8Array): Promise<void> {
    if (this._disposed || !this.audioContext) return;
    if (!this._aacConfig) {
      // Init not parsed yet (or not AAC). Drop this segment.
      return;
    }

    const adts = fmp4ToAdts(media, this._aacConfig);
    if (!adts || adts.length === 0) {
      this._reportFail("could not extract AAC frames from media segment");
      return;
    }

    // Copy into a standalone ArrayBuffer (decodeAudioData detaches it).
    const buf = new Uint8Array(adts).buffer;

    let audioBuffer;
    try {
      audioBuffer = await this.audioContext.decodeAudioData(buf);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this._reportFail(`decodeAudioData(ADTS) rejected: ${msg}`);
      return;
    }
    this._failCount = 0;
    if (this._disposed) return;

    const channels = audioBuffer.numberOfChannels;
    const sampleRate = audioBuffer.sampleRate;
    const sampleCount = audioBuffer.length;

    const pcm = new Float32Array(sampleCount * channels);
    for (let ch = 0; ch < channels; ch += 1) {
      const data = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sampleCount; i += 1) {
        pcm[i * channels + ch] = data[i];
      }
    }

    const ptsMs = this._timelineSec * 1000;
    this._timelineSec += audioBuffer.duration;
    this._started = true;

    this.onPcm({ channels, sampleRate, sampleCount, pcm, ptsMs });
  }

  _reportFail(msg: string): void {
    this._failCount += 1;
    if (this._failCount <= 3) {
      this.onError(new Error(`${msg} (#${this._failCount})`));
    }
    console.warn("[mp4-audio]", msg);
  }

  /** Reset the timeline (e.g. on seek) but keep the init/config. */
  reset(): void {
    this._timelineSec = 0;
    this._started = false;
    this._failCount = 0;
    this._decodeChain = Promise.resolve();
  }

  /** Full reset including init/config (e.g. switching streams). */
  clear(): void {
    this.reset();
    this._initSegment = null;
    this._aacConfig = null;
  }

  dispose(): void {
    this._disposed = true;
    this.clear();
  }
}

export default Mp4AudioDecoder;
