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

const ADTS_FREQ_TABLE = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

/** Parsed AudioSpecificConfig fields needed to build ADTS headers. */
export interface AacConfig {
  audioObjectType: number; // e.g. 2 = AAC-LC
  samplingFrequencyIndex: number; // 0..12 (15 = explicit, mapped to nearest)
  sampleRate: number;
  channelConfig: number; // 1..7
}

/* ----------------------------- box helpers ----------------------------- */

function readU32(b: Uint8Array, p: number): number {
  return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
}

interface Box {
  type: string;
  start: number; // content start (after 8 or 16 byte header)
  end: number; // exclusive
}

/** Iterate boxes between [start, end). Handles 64-bit largesize. */
function boxes(b: Uint8Array, start: number, end: number): Box[] {
  const out: Box[] = [];
  let p = start;
  while (p + 8 <= end) {
    let size = readU32(b, p);
    const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
    let headerLen = 8;
    if (size === 1) {
      // 64-bit size; we ignore the high 32 bits (segments are small).
      size = readU32(b, p + 12);
      headerLen = 16;
    } else if (size === 0) {
      size = end - p; // extends to end
    }
    if (size < headerLen || p + size > end) break;
    out.push({ type, start: p + headerLen, end: p + size });
    p += size;
  }
  return out;
}

function findFirst(b: Uint8Array, start: number, end: number, type: string): Box | null {
  for (const box of boxes(b, start, end)) {
    if (box.type === type) return box;
  }
  return null;
}

/* --------------------------- ASC (from init) --------------------------- */

function readDescriptorLen(b: Uint8Array, pos: number): { len: number; pos: number } {
  let len = 0;
  let count = 0;
  let byte: number;
  do {
    byte = b[pos++];
    len = (len << 7) | (byte & 0x7f);
    count += 1;
  } while (byte & 0x80 && count < 4);
  return { len, pos };
}

/** Pull the AudioSpecificConfig bytes out of an `esds` box content. */
function ascFromEsds(esds: Uint8Array): Uint8Array | null {
  let p = 4; // skip version + flags (fullbox)

  if (esds[p] === 0x03) {
    // ES_Descriptor
    p += 1;
    p = readDescriptorLen(esds, p).pos;
    p += 2; // ES_ID
    const flags = esds[p];
    p += 1;
    if (flags & 0x80) p += 2; // dependsOn ES_ID
    if (flags & 0x40) {
      const urlLen = esds[p];
      p += 1 + urlLen;
    }
    if (flags & 0x20) p += 2; // OCR ES_ID
  }

  if (esds[p] === 0x04) {
    // DecoderConfigDescriptor
    p += 1;
    p = readDescriptorLen(esds, p).pos;
    p += 1; // objectTypeIndication
    p += 1; // streamType/upstream/reserved
    p += 3; // bufferSizeDB
    p += 4; // maxBitrate
    p += 4; // avgBitrate
  }

  if (esds[p] === 0x05) {
    // DecoderSpecificInfo = AudioSpecificConfig
    p += 1;
    const r = readDescriptorLen(esds, p);
    p = r.pos;
    return esds.slice(p, p + r.len);
  }
  return null;
}

function parseAsc(asc: Uint8Array): AacConfig {
  let bitPos = 0;
  const readBits = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i += 1) {
      const byteIdx = bitPos >> 3;
      const bit = 7 - (bitPos & 7);
      v = (v << 1) | ((asc[byteIdx] >> bit) & 1);
      bitPos += 1;
    }
    return v;
  };

  let aot = readBits(5);
  if (aot === 31) aot = 32 + readBits(6);
  let freqIndex = readBits(4);
  let sampleRate: number;
  if (freqIndex === 15) {
    sampleRate = readBits(24);
    // Map explicit rate back to the nearest ADTS table index.
    freqIndex = nearestFreqIndex(sampleRate);
  } else {
    sampleRate = ADTS_FREQ_TABLE[freqIndex] || 44100;
  }
  const channelConfig = readBits(4);
  return { audioObjectType: aot, samplingFrequencyIndex: freqIndex, sampleRate, channelConfig };
}

function nearestFreqIndex(rate: number): number {
  let best = 0;
  let bestDiff = Infinity;
  for (let i = 0; i < ADTS_FREQ_TABLE.length; i += 1) {
    const diff = Math.abs(ADTS_FREQ_TABLE[i] - rate);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return best;
}

/** Parse an audio init segment (ftyp+moov) → AacConfig, or null if not AAC. */
export function parseAudioInit(initBytes: Uint8Array): AacConfig | null {
  const len = initBytes.length;
  const moov = findFirst(initBytes, 0, len, "moov");
  if (!moov) return null;
  const trak = findFirst(initBytes, moov.start, moov.end, "trak");
  if (!trak) return null;
  const mdia = findFirst(initBytes, trak.start, trak.end, "mdia");
  if (!mdia) return null;
  const minf = findFirst(initBytes, mdia.start, mdia.end, "minf");
  if (!minf) return null;
  const stbl = findFirst(initBytes, minf.start, minf.end, "stbl");
  if (!stbl) return null;
  const stsd = findFirst(initBytes, stbl.start, stbl.end, "stsd");
  if (!stsd) return null;

  // stsd is a fullbox: 4 bytes version/flags + 4 bytes entry_count, then entries.
  const entriesStart = stsd.start + 8;
  const sampleEntry = boxes(initBytes, entriesStart, stsd.end)[0];
  if (!sampleEntry) return null;
  if (sampleEntry.type !== "mp4a" && sampleEntry.type !== "enca") {
    // Not AAC in an mp4a entry; caller may fall back.
    return null;
  }

  // AudioSampleEntry: 28 bytes of fixed fields after the box header, then
  // child boxes (esds). sampleEntry.start already points past the 8-byte header.
  const childStart = sampleEntry.start + 28;
  const esds = findFirst(initBytes, childStart, sampleEntry.end, "esds");
  if (!esds) return null;

  const asc = ascFromEsds(initBytes.slice(esds.start, esds.end));
  if (!asc || asc.length < 2) return null;
  return parseAsc(asc);
}

/* ------------------------- media → ADTS frames ------------------------- */

/** Collect per-sample byte sizes from a moof's traf(s). */
function sampleSizesFromMoof(b: Uint8Array, moof: Box): number[] {
  const sizes: number[] = [];
  for (const traf of boxes(b, moof.start, moof.end)) {
    if (traf.type !== "traf") continue;

    let defaultSampleSize = 0;
    const tfhd = findFirst(b, traf.start, traf.end, "tfhd");
    if (tfhd) {
      // fullbox: 1 byte version + 3 bytes flags
      const flags = ((b[tfhd.start + 1] << 16) | (b[tfhd.start + 2] << 8) | b[tfhd.start + 3]) >>> 0;
      let p = tfhd.start + 4 + 4; // skip version/flags + track_ID
      if (flags & 0x000001) p += 8; // base-data-offset
      if (flags & 0x000002) p += 4; // sample-description-index
      if (flags & 0x000008) p += 4; // default-sample-duration
      if (flags & 0x000010) {
        defaultSampleSize = readU32(b, p);
        p += 4;
      }
      // default-sample-flags (0x000020) ignored
    }

    const trun = findFirst(b, traf.start, traf.end, "trun");
    if (!trun) continue;
    const flags = ((b[trun.start + 1] << 16) | (b[trun.start + 2] << 8) | b[trun.start + 3]) >>> 0;
    let p = trun.start + 4; // skip version/flags
    const sampleCount = readU32(b, p);
    p += 4;
    if (flags & 0x000001) p += 4; // data-offset
    if (flags & 0x000004) p += 4; // first-sample-flags

    const hasDuration = (flags & 0x000100) !== 0;
    const hasSize = (flags & 0x000200) !== 0;
    const hasFlags = (flags & 0x000400) !== 0;
    const hasCto = (flags & 0x000800) !== 0;

    for (let i = 0; i < sampleCount; i += 1) {
      if (hasDuration) p += 4;
      let size = defaultSampleSize;
      if (hasSize) {
        size = readU32(b, p);
        p += 4;
      }
      if (hasFlags) p += 4;
      if (hasCto) p += 4;
      sizes.push(size);
    }
  }
  return sizes;
}

function makeAdtsHeader(cfg: AacConfig, frameLen: number): Uint8Array {
  const profileMinus1 = Math.max(0, cfg.audioObjectType - 1) & 0x3;
  const freqIdx = cfg.samplingFrequencyIndex & 0xf;
  const ch = cfg.channelConfig & 0x7;
  const total = frameLen + 7;
  const h = new Uint8Array(7);
  h[0] = 0xff;
  h[1] = 0xf1; // syncword + MPEG-4 + layer 0 + protection_absent
  h[2] = (profileMinus1 << 6) | (freqIdx << 2) | ((ch >> 2) & 0x1);
  h[3] = ((ch & 0x3) << 6) | ((total >> 11) & 0x3);
  h[4] = (total >> 3) & 0xff;
  h[5] = ((total & 0x7) << 5) | 0x1f;
  h[6] = 0xfc;
  return h;
}

/**
 * Convert a CMAF audio media segment (moof+mdat, possibly multiple) into a
 * concatenated ADTS-AAC byte stream decodable by decodeAudioData.
 * Returns null if the segment shape is unexpected.
 */
export function fmp4ToAdts(mediaBytes: Uint8Array, cfg: AacConfig): Uint8Array | null {
  const len = mediaBytes.length;
  const top = boxes(mediaBytes, 0, len);

  const chunks: Uint8Array[] = [];
  let pendingSizes: number[] | null = null;

  for (const box of top) {
    if (box.type === "moof") {
      pendingSizes = sampleSizesFromMoof(mediaBytes, box);
    } else if (box.type === "mdat" && pendingSizes) {
      let p = box.start;
      for (const size of pendingSizes) {
        if (size <= 0 || p + size > box.end) break;
        const frame = mediaBytes.subarray(p, p + size);
        p += size;
        chunks.push(makeAdtsHeader(cfg, frame.length));
        chunks.push(frame);
      }
      pendingSizes = null;
    }
  }

  if (chunks.length === 0) return null;

  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}
