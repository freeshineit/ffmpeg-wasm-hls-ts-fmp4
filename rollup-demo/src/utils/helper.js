class Helper {
  /**
   * Per-track fetch loop state. Each track ("muxed" | "video" | "audio")
   * carries its own seen-set, init-loaded flag and abort controller.
   */
  static makeTrackState(kind, url) {
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
}

export default Helper;
