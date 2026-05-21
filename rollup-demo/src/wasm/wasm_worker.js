self.window = self; // Polyfill for Emscripten

let wasmModule = null;
let playerHandle = 0;

self.onmessage = async (e) => {
  const { type, payload } = e.data;

  try {
    switch (type) {
      case 'init':
        await initWasm(payload);
        break;
      case 'feedSegment':
        feedSegment(payload);
        break;
      case 'reset':
        resetPlayer();
        break;
      case 'destroy':
        destroyPlayer();
        break;
      default:
        console.warn(`[WasmWorker] Unknown message type: ${type}`);
    }
  } catch (error) {
    self.postMessage({ type: 'error', payload: error.message });
  }
};

async function initWasm({ wasmJsUrl, wasmFileUrl }) {
  if (wasmModule) return;

  importScripts(wasmJsUrl);

  const hlsModuleFactory = self.HlsPlayerModule;
  if (typeof hlsModuleFactory !== "function") {
    throw new Error("HlsPlayerModule is not available after loading wasm JS in worker.");
  }

  wasmModule = await hlsModuleFactory({
    locateFile: (path) => {
      if (path.endsWith(".wasm")) {
        return wasmFileUrl;
      }
      return path;
    },
    onVideoFrame: (width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs, isKeyFrame, codecName) => {
      const ySize = yStride * height;
      const uvHeight = height >> 1;
      const uSize = uStride * uvHeight;
      const vSize = vStride * uvHeight;

      // Copy data to avoid shared memory issues when transferring to main thread
      const y = new Uint8Array(wasmModule.HEAPU8.buffer, yPtr, ySize).slice();
      const u = new Uint8Array(wasmModule.HEAPU8.buffer, uPtr, uSize).slice();
      const v = new Uint8Array(wasmModule.HEAPU8.buffer, vPtr, vSize).slice();

      self.postMessage({
        type: 'videoFrame',
        payload: { width, height, y, u, v, yStride, uStride, vStride, ptsMs, isKeyFrame, codecName }
      }, [y.buffer, u.buffer, v.buffer]); // Transfer buffer ownership
    },
    onAudioFrame: (channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName) => {
      const sampleNum = channels * sampleCount;
      const pcm = new Float32Array(wasmModule.HEAPU8.buffer, dataPtr, sampleNum).slice();
      
      self.postMessage({
        type: 'audioFrame',
        payload: { channels, sampleRate, sampleCount, pcm, ptsMs, codecName }
      }, [pcm.buffer]); // Transfer buffer ownership
    },
    onLog: (level, msg) => {
      self.postMessage({ type: 'log', payload: { level, msg } });
    },
  });

  playerHandle = wasmModule._player_create();
  
  self.postMessage({ type: 'initReady' });
}

function feedSegment({ bytes, isInitSegment }) {
  if (!wasmModule || !playerHandle) {
    throw new Error("WASM player has not been initialized in worker.");
  }

  const ptr = wasmModule._malloc(bytes.length);
  wasmModule.HEAPU8.set(bytes, ptr);

  const ret = wasmModule._player_feed_segment(playerHandle, ptr, bytes.length, isInitSegment ? 1 : 0);

  wasmModule._free(ptr);

  if (ret < 0) {
    throw new Error(`player_feed_segment failed: ${ret}`);
  }
  
  // Need to sync getCurrentTime back to main thread periodically if needed,
  // but let's notify the main thread that feedSegment is done.
  const currentTime = wasmModule._player_get_current_time(playerHandle);
  self.postMessage({ type: 'feedDone', payload: { currentTime } });
}

function resetPlayer() {
  if (wasmModule && playerHandle) {
    wasmModule._player_reset(playerHandle);
  }
}

function destroyPlayer() {
  if (wasmModule && playerHandle) {
    wasmModule._player_destroy(playerHandle);
    playerHandle = 0;
  }
}
