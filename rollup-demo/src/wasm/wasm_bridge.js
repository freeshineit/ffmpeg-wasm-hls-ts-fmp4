export class WasmBridge {
  constructor({ wasmJsUrl, wasmFileUrl }) {
    this.wasmJsUrl = wasmJsUrl;
    this.wasmFileUrl = wasmFileUrl;
    this.module = null;
    this.handle = 0;
  }

  async init({ onVideoFrame, onAudioFrame, onLog }) {
    await this.#ensureWasmScriptLoaded();
    const hlsModuleFactory = window.HlsPlayerModule;
    if (typeof hlsModuleFactory !== "function") {
      throw new Error(
        "HlsPlayerModule is not available after loading wasm JS.",
      );
    }
    this.module = await hlsModuleFactory({
      locateFile: (path) => {
        if (path.endsWith(".wasm")) {
          return this.wasmFileUrl;
        }
        return path;
      },
      onVideoFrame,
      onAudioFrame,
      onLog,
    });

    this.handle = this.module._player_create();
  }

  async #ensureWasmScriptLoaded() {
    if (typeof window.HlsPlayerModule === "function") {
      return;
    }

    await new Promise((resolve, reject) => {
      const existing = document.querySelector(
        `script[data-wasm-loader="${this.wasmJsUrl}"]`,
      );
      if (existing) {
        existing.addEventListener("load", () => resolve(), { once: true });
        existing.addEventListener(
          "error",
          () => reject(new Error(`Failed to load ${this.wasmJsUrl}`)),
          {
            once: true,
          },
        );
        return;
      }

      const script = document.createElement("script");
      script.src = this.wasmJsUrl;
      script.async = true;
      script.dataset.wasmLoader = this.wasmJsUrl;
      script.onload = () => resolve();
      script.onerror = () =>
        reject(new Error(`Failed to load ${this.wasmJsUrl}`));
      document.head.appendChild(script);
    });
  }

  feedSegment(bytes, isInitSegment) {
    if (!this.module || !this.handle) {
      throw new Error("WASM player has not been initialized.");
    }

    const ptr = this.module._malloc(bytes.length);
    this.module.HEAPU8.set(bytes, ptr);

    const ret = this.module._player_feed_segment(
      this.handle,
      ptr,
      bytes.length,
      isInitSegment ? 1 : 0,
    );

    this.module._free(ptr);

    if (ret < 0) {
      throw new Error(`player_feed_segment failed: ${ret}`);
    }
  }

  reset() {
    if (this.module && this.handle) {
      this.module._player_reset(this.handle);
    }
  }

  getCurrentTime() {
    if (this.module && this.handle && this.module._player_get_current_time) {
      return this.module._player_get_current_time(this.handle);
    }
    return 0;
  }

  destroy() {
    if (this.module && this.handle) {
      this.module._player_destroy(this.handle);
      this.handle = 0;
    }
  }
}
