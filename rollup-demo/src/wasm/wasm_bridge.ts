interface WasmBridgeOptions {
  wasmJsUrl: string;
  wasmFileUrl: string;
}

interface WasmInitCallbacks {
  onVideoFrame: (
    width: number,
    height: number,
    yPtr: number | null,
    yStride: number,
    uPtr: number | null,
    uStride: number,
    vPtr: number | null,
    vStride: number,
    ptsMs: number,
    isKeyFrame: boolean,
    codecName: string,
    yData: Uint8Array,
    uData: Uint8Array,
    vData: Uint8Array,
  ) => void;
  onAudioFrame: (
    channels: number,
    sampleRate: number,
    sampleCount: number,
    dataPtr: number | null,
    ptsMs: number,
    codecName: string,
    pcmData: Float32Array,
  ) => void;
  onLog: (level: string, msg: string) => void;
}

export class WasmBridge {
  wasmJsUrl: string;
  wasmFileUrl: string;
  worker: Worker | null;
  initPromiseResolver: (() => void) | null;
  initPromiseRejecter: ((error: Error) => void) | null;
  _currentTime: number;

  constructor({ wasmJsUrl, wasmFileUrl }: WasmBridgeOptions) {
    this.wasmJsUrl = wasmJsUrl;
    this.wasmFileUrl = wasmFileUrl;
    this.worker = null;
    this.initPromiseResolver = null;
    this.initPromiseRejecter = null;
    this._currentTime = 0;
  }

  async init({ onVideoFrame, onAudioFrame, onLog }: WasmInitCallbacks): Promise<void> {
    return new Promise((resolve, reject) => {
      this.initPromiseResolver = resolve;
      this.initPromiseRejecter = reject;

      this.worker = new Worker(new URL('/wasm/wasm_worker.js', window.location.href));

      this.worker.onmessage = (e: MessageEvent) => {
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

  feedSegment(bytes: Uint8Array, isInitSegment: boolean): void {
    if (!this.worker) {
      throw new Error("WASM worker has not been initialized.");
    }

    // Copy bytes so we can transfer ownership to avoid blocking main thread and clone overhead
    let bytesCopy: Uint8Array;
    try {
      bytesCopy = new Uint8Array(bytes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to copy segment buffer (${bytes.length} bytes): ${msg}. ` +
        `System may be under memory pressure.`
      );
    }

    this.worker.postMessage({
      type: 'feedSegment',
      payload: { bytes: bytesCopy, isInitSegment }
    }, [bytesCopy.buffer]);
  }

  reset(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'reset' });
      this._currentTime = 0;
    }
  }

  getCurrentTime(): number {
    // Current time is now synced from feedDone events asynchronously
    return this._currentTime;
  }

  destroy(): void {
    if (this.worker) {
      this.worker.postMessage({ type: 'destroy' });
      this.worker.terminate();
      this.worker = null;
    }
  }
}
