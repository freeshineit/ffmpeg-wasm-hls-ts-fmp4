/**
 * Split a string on commas that lie outside double-quoted regions.
 * Required for HLS attribute lists where quoted values may contain commas,
 * e.g. CODECS="avc1.4d0029,mp4a.40.2".
 */
function splitTopLevelCommas(content) {
  const out = [];
  let buf = "";
  let inQuote = false;
  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];
    if (ch === '"') {
      inQuote = !inQuote;
      buf += ch;
      continue;
    }
    if (ch === "," && !inQuote) {
      out.push(buf);
      buf = "";
      continue;
    }
    buf += ch;
  }
  if (buf.length > 0) {
    out.push(buf);
  }
  return out;
}

function parseAttributeListBody(content) {
  const attrs = {};
  const items = splitTopLevelCommas(content);
  for (const item of items) {
    const eq = item.indexOf("=");
    if (eq < 0) {
      continue;
    }
    const k = item.slice(0, eq).trim();
    let v = item.slice(eq + 1).trim();
    if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
      v = v.slice(1, -1);
    }
    if (k) {
      attrs[k] = v;
    }
  }
  return attrs;
}

function parseAttributeList(line) {
  const content = line.slice(line.indexOf(":") + 1);
  return parseAttributeListBody(content);
}

/**
 * Classify a playlist as "master" (multivariant) or "media" (chunklist).
 *  - Has any #EXT-X-STREAM-INF and no #EXTINF -> master
 *  - Otherwise -> media (current default behavior)
 */
export function classifyPlaylist(text) {
  const hasStreamInf = /^#EXT-X-STREAM-INF[: ]/m.test(text);
  const hasExtinf = /^#EXTINF[: ]/m.test(text);
  if (hasStreamInf && !hasExtinf) {
    return "master";
  }
  return "media";
}

/**
 * Parse a Master (Multivariant) Playlist. Returns:
 *   {
 *     variants: [{ bandwidth, codecs, resolution, audioGroup, uri }],
 *     audioGroups: { [groupId]: [{ groupId, name, default, language, uri }] },
 *   }
 * URIs are resolved against playlistUrl, preserving any per-URI query string.
 */
export function parseMasterPlaylist(text, playlistUrl) {
  const lines = text.split(/\r?\n/);
  const result = {
    variants: [],
    audioGroups: {},
  };

  let pendingStreamInf = null;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA:")) {
      const attrs = parseAttributeList(line);
      if (attrs.TYPE === "AUDIO") {
        const groupId = attrs["GROUP-ID"] || "";
        const rendition = {
          groupId,
          name: attrs.NAME || "",
          default: attrs.DEFAULT === "YES",
          language: attrs.LANGUAGE || null,
          uri: attrs.URI ? new URL(attrs.URI, playlistUrl).toString() : null,
        };
        if (!result.audioGroups[groupId]) {
          result.audioGroups[groupId] = [];
        }
        result.audioGroups[groupId].push(rendition);
      }
      continue;
    }

    if (line.startsWith("#EXT-X-STREAM-INF:")) {
      const attrs = parseAttributeList(line);
      pendingStreamInf = {
        bandwidth: Number(attrs.BANDWIDTH || 0),
        codecs: attrs.CODECS || "",
        resolution: attrs.RESOLUTION || "",
        audioGroup: attrs.AUDIO || null,
      };
      continue;
    }

    if (!line.startsWith("#") && pendingStreamInf) {
      result.variants.push({
        ...pendingStreamInf,
        uri: new URL(line, playlistUrl).toString(),
      });
      pendingStreamInf = null;
    }
  }

  return result;
}

/**
 * Pick the default variant (highest BANDWIDTH, first-in-source-order on tie)
 * and resolve its audio rendition (DEFAULT=YES preferred, else first in group).
 * Returns { variant, audio } where either may be null.
 */
export function selectVariantAndAudio(master) {
  if (!master || !master.variants || master.variants.length === 0) {
    return { variant: null, audio: null };
  }

  let best = master.variants[0];
  for (let i = 1; i < master.variants.length; i += 1) {
    const v = master.variants[i];
    if (Number.isFinite(v.bandwidth) && v.bandwidth > best.bandwidth) {
      best = v;
    }
  }

  let audio = null;
  if (best.audioGroup && master.audioGroups[best.audioGroup]) {
    const group = master.audioGroups[best.audioGroup];
    audio = group.find((r) => r.default && r.uri) || group.find((r) => r.uri) || null;
  }

  return { variant: best, audio };
}

export function parseMediaPlaylist(text, playlistUrl) {
  const base = new URL(".", playlistUrl).toString();
  const lines = text.split(/\r?\n/);

  const result = {
    targetDuration: 6,
    mediaSequence: 0,
    partTarget: null,
    isEndList: false,
    initSegment: null,
    segments: [],
    parts: [],
    preloadHint: null,
  };

  let currentDuration = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) {
      continue;
    }

    if (line.startsWith("#EXT-X-TARGETDURATION:")) {
      result.targetDuration = Number(line.split(":")[1] || 6);
      continue;
    }

    if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
      result.mediaSequence = Number(line.split(":")[1] || 0);
      continue;
    }

    if (line.startsWith("#EXT-X-PART-INF:")) {
      const attrs = parseAttributeList(line);
      result.partTarget = Number(attrs.PARTTARGET || 0);
      continue;
    }

    if (line.startsWith("#EXT-X-MAP:")) {
      const attrs = parseAttributeList(line);
      if (attrs.URI) {
        result.initSegment = new URL(attrs.URI, base).toString();
      }
      continue;
    }

    if (line.startsWith("#EXT-X-PART:")) {
      const attrs = parseAttributeList(line);
      if (attrs.URI) {
        result.parts.push({
          url: new URL(attrs.URI, base).toString(),
          duration: Number(attrs.DURATION || 0),
          independent: attrs.INDEPENDENT === "YES",
        });
      }
      continue;
    }

    if (line.startsWith("#EXT-X-PRELOAD-HINT:")) {
      const attrs = parseAttributeList(line);
      if (attrs.URI) {
        result.preloadHint = new URL(attrs.URI, base).toString();
      }
      continue;
    }

    if (line.startsWith("#EXTINF:")) {
      currentDuration = Number(line.slice(8).split(",")[0]);
      continue;
    }

    if (line === "#EXT-X-ENDLIST") {
      result.isEndList = true;
      continue;
    }

    if (!line.startsWith("#")) {
      result.segments.push({
        url: new URL(line, base).toString(),
        duration: currentDuration,
      });
      currentDuration = 0;
    }
  }

  return result;
}
