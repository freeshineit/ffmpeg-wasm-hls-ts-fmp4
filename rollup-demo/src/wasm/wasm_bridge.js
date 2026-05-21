export class WasmBridge {
  constructor({ wasmJsUrl, wasmFileUrl }) {
    this.wasmJsUrl = wasmJsUrl;
    this.wasmFileUrl = wasmFileUrl;
    this.worker = null;
    this.initPromiseResolver = null;
    this.initPromiseRejecter = null;
    this._currentTime = 0;
  }

  async init({ onVideoFrame, onAudioFrame, onLog }) {
    return new Promise((resolve, reject) => {
      this.initPromiseResolver = resolve;
      this.initPromiseRejecter = reject;

      this.worker = new Worker(new URL('/wasm/wasm_worker.js', window.location.href));

      this.worker.onmessage = (e) => {
        const { type, payload } = e.data;
        switch (type) {
          case 'initReady':
            if (this.initPromiseResolver) {
              this.initPromiseResolver();
              this.initPromiseResolver = null;
              this.initPromiseRejecter = null;
            }
            break;
          case 'videoFrame':
            onVideoFrame(
              payload.width, payload.height,
              null, payload.yStride, // We don't have pointers anymore, we pass arrays in player.js directly soon
              null, payload.uStride,
              null, payload.vStride,
              payload.ptsMs, payload.isKeyFrame, payload.codecName,
              payload.y, payload.u, payload.v // Pass arrays to player.js
            );
            break;
          case 'audioFrame':
            onAudioFrame(
              payload.channels, payload.sampleRate, payload.sampleCount,
              null, payload.ptsMs, payload.codecName,
              payload.pcm // Pass Float32Array to player.js
            );
            break;
          case 'log':
            onLog(payload.level, payload.msg);
            break;
          case 'feedDone':
            this._currentTime = payload.currentTime;
            break;
          case 'error':
            console.error('[WasmBridge]', payload);
            if (this.initPromiseRejecter) {
              this.initPromiseRejecter(new Error(payload));
              this.initPromiseRejecter = null;
              this.initPromiseResolver = null;
            }
            break;
        }
      };

      // Since worker load context may differ, converting to absolute path could be safer
      const absoluteWasmJsUrl = new URL(this.wasmJsUrl, window.location.href).href;
      const absoluteWasmFileUrl = new URL(this.wasmFileUrl, window.location.href).href;

      this.worker.postMessage({
        type: 'init',
        payload: {
          wasmJsUrl: absoluteWasmJsUrl,
          wasmFileUrl: absoluteWasmFileUrl
        }
      });
    });
  }

  feedSegment(bytes, isInitSegment) {
    if (!this.worker) {
      throw new Error("WASM worker has not been initialized.");
    }
    
    // Copy bytes so we can transfer ownership to avoid blocking main thread and clone overhead
    const bytesCopy = new Uint8Array(bytes);
    this.worker.postMessage({
      type: 'feedSegment',
      payload: { bytes: bytesCopy, isInitSegment }
    }, [bytesCopy.buffer]);
  }

  reset() {
    if (this.worker) {
      this.worker.postMessage({ type: 'reset' });
      this._currentTime = 0;
    }
  }

  getCurrentTime() {
    // Current time is now synced from feedDone events asynchronously
    return this._currentTime;
  }

  destroy() {
    if (this.worker) {
      this.worker.postMessage({ type: 'destroy' });
      this.worker.terminate();
      this.worker = null;
    }
  }
}
