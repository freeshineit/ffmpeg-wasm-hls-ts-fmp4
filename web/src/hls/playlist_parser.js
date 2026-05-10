function parseAttributeList(line) {
  const attrs = {};
  const content = line.slice(line.indexOf(":") + 1);
  for (const item of content.split(",")) {
    const [k, rawV] = item.split("=");
    if (!k || rawV === undefined) {
      continue;
    }
    attrs[k.trim()] = rawV.trim().replace(/^"|"$/g, "");
  }
  return attrs;
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
