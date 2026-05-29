class Helper {
  /**
   * Per-track fetch loop state. Each track ("muxed" | "video" | "audio")
   * carries its own seen-set, init-loaded flag and abort controller.
   */
  static makeTrackState(
    kind: "muxed" | "video" | "audio",
    url: string,
  ): {
    kind: "muxed" | "video" | "audio";
    url: string;
    seen: Set<string>;
    initLoaded: boolean;
    abort: AbortController | null;
    sleepResolve: (() => void) | null;
    running: boolean;
  } {
    return {
      kind,
      url,
      seen: new Set(),
      initLoaded: false,
      abort: null,
      sleepResolve: null,
      running: false,
    };
  }

  /**
   * Merge two HeadersInit-ish values into a plain object.
   */
  static flattenHeaders(h?: HeadersInit): Record<string, string> {
    const out: Record<string, string> = {};
    if (!h) return out;
    if (h instanceof Headers) {
      h.forEach((v, k) => {
        out[k] = v;
      });
    } else if (Array.isArray(h)) {
      for (const [k, v] of h) out[k] = v;
    } else {
      Object.assign(out, h);
    }
    return out;
  }
}

export default Helper;
