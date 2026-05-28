self.window = self; // Polyfill for Emscripten

let wasmModule = null;
let playerHandle = 0;

// --- Safety limits to prevent runaway allocations from corrupt frame data ---
const MAX_FRAME_WIDTH = 8192;
const MAX_FRAME_HEIGHT = 4320;
const MAX_PLANE_BYTES = 256 * 1024 * 1024; // 256 MiB per plane
const MAX_AUDIO_SAMPLES = 192000; // 4s @ 48kHz mono
const MAX_AUDIO_CHANNELS = 8;

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

/** Safely copy a slice of WASM heap into a new typed array, catching RangeError. */
function safeSliceView(TypedArrayCtor, buffer, byteOffset, length) {
  try {
    return new TypedArrayCtor(buffer, byteOffset, length).slice();
  } catch (_) {
    return null;
  }
}

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
      // --- Validate frame metadata before touching memory ---
      if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
      if (width > MAX_FRAME_WIDTH || height > MAX_FRAME_HEIGHT) {
        self.postMessage({ type: 'log', payload: { level: 'warn', msg: `[wasm_worker] Rejected oversize video frame ${width}x${height}` } });
        return;
      }

      const ySize = yStride * height;
      const uvHeight = height >> 1;
      const uSize = uStride * uvHeight;
      const vSize = vStride * uvHeight;

      // Reject any plane that would exceed the safety cap
      const maxPlane = Math.min(MAX_PLANE_BYTES, wasmModule.HEAPU8.byteLength);
      if (ySize > maxPlane || ySize <= 0 || uSize > maxPlane || uSize <= 0 || vSize > maxPlane || vSize <= 0) {
        self.postMessage({ type: 'log', payload: { level: 'warn', msg: `[wasm_worker] Rejected oversize plane y=${ySize} u=${uSize} v=${vSize}` } });
        return;
      }

      // Validate pointers are within the WASM heap
      const heapEnd = wasmModule.HEAPU8.byteLength;
      if (yPtr < 0 || yPtr + ySize > heapEnd || uPtr < 0 || uPtr + uSize > heapEnd || vPtr < 0 || vPtr + vSize > heapEnd) {
        self.postMessage({ type: 'log', payload: { level: 'warn', msg: `[wasm_worker] Plane pointer OOB yPtr=${yPtr} ySize=${ySize} heap=${heapEnd}` } });
        return;
      }

      // Copy data out of WASM heap; catches RangeError from allocation failure
      const y = safeSliceView(Uint8Array, wasmModule.HEAPU8.buffer, yPtr, ySize);
      const u = safeSliceView(Uint8Array, wasmModule.HEAPU8.buffer, uPtr, uSize);
      const v = safeSliceView(Uint8Array, wasmModule.HEAPU8.buffer, vPtr, vSize);
      if (!y || !u || !v) {
        self.postMessage({ type: 'log', payload: { level: 'error', msg: `[wasm_worker] Video frame copy failed (y=${ySize} u=${uSize} v=${vSize}, heap=${(heapEnd / 1e6).toFixed(0)}MB)` } });
        return;
      }

      self.postMessage({
        type: 'videoFrame',
        payload: { width, height, y, u, v, yStride, uStride, vStride, ptsMs, isKeyFrame, codecName }
      }, [y.buffer, u.buffer, v.buffer]); // Transfer buffer ownership
    },
    onAudioFrame: (channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName) => {
      // --- Validate audio metadata ---
      if (!Number.isFinite(channels) || channels <= 0 || channels > MAX_AUDIO_CHANNELS) return;
      if (!Number.isFinite(sampleCount) || sampleCount <= 0) return;

      const sampleNum = channels * sampleCount;
      if (sampleNum > MAX_AUDIO_SAMPLES) {
        self.postMessage({ type: 'log', payload: { level: 'warn', msg: `[wasm_worker] Rejected oversize audio frame samples=${sampleNum}` } });
        return;
      }

      const heapEnd = wasmModule.HEAPU8.byteLength;
      const byteLen = sampleNum * 4; // Float32
      if (dataPtr < 0 || dataPtr + byteLen > heapEnd) {
        self.postMessage({ type: 'log', payload: { level: 'warn', msg: `[wasm_worker] Audio pointer OOB ptr=${dataPtr} len=${byteLen} heap=${heapEnd}` } });
        return;
      }

      const pcm = safeSliceView(Float32Array, wasmModule.HEAPU8.buffer, dataPtr, sampleNum);
      if (!pcm) {
        self.postMessage({ type: 'log', payload: { level: 'error', msg: `[wasm_worker] Audio frame copy failed (samples=${sampleNum}, heap=${(heapEnd / 1e6).toFixed(0)}MB)` } });
        return;
      }

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

  // Attempt allocation; if the WASM heap can't grow we fail gracefully
  const ptr = wasmModule._malloc(bytes.length);
  if (!ptr) {
    const heapMB = (wasmModule.HEAPU8.byteLength / 1e6).toFixed(1);
    throw new Error(
      `WASM malloc failed for ${bytes.length} bytes (heap=${heapMB}MB). ` +
      `The WASM heap may be exhausted. Consider lowering resolution, ` +
      `reducing buffered segments, or restarting playback.`
    );
  }

  try {
    wasmModule.HEAPU8.set(bytes, ptr);

    const ret = wasmModule._player_feed_segment(playerHandle, ptr, bytes.length, isInitSegment ? 1 : 0);

    if (ret < 0) {
      throw new Error(`player_feed_segment failed: ${ret}`);
    }

    const currentTime = wasmModule._player_get_current_time(playerHandle);
    self.postMessage({ type: 'feedDone', payload: { currentTime } });
  } finally {
    wasmModule._free(ptr);
  }
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
