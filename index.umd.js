(function (global, factory) {
    typeof exports === 'object' && typeof module !== 'undefined' ? factory(exports) :
    typeof define === 'function' && define.amd ? define(['exports'], factory) :
    (global = typeof globalThis !== 'undefined' ? globalThis : global || self, factory(global.HlsWasmApp = {}));
})(this, (function (exports) { 'use strict';

    /******************************************************************************
    Copyright (c) Microsoft Corporation.

    Permission to use, copy, modify, and/or distribute this software for any
    purpose with or without fee is hereby granted.

    THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
    REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY
    AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
    INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM
    LOSS OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR
    OTHER TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR
    PERFORMANCE OF THIS SOFTWARE.
    ***************************************************************************** */
    /* global Reflect, Promise, SuppressedError, Symbol, Iterator */


    function __classPrivateFieldGet(receiver, state, kind, f) {
        if (kind === "a" && !f) throw new TypeError("Private accessor was defined without a getter");
        if (typeof state === "function" ? receiver !== state || !f : !state.has(receiver)) throw new TypeError("Cannot read private member from an object whose class did not declare it");
        return kind === "m" ? f : kind === "a" ? f.call(receiver) : f ? f.value : state.get(receiver);
    }

    typeof SuppressedError === "function" ? SuppressedError : function (error, suppressed, message) {
        var e = new Error(message);
        return e.name = "SuppressedError", e.error = error, e.suppressed = suppressed, e;
    };

    class Texture {
        constructor(gl) {
            this.gl = gl;
            this.texture = gl.createTexture();
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
            gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        }
        bind(unit, program, samplerName) {
            const gl = this.gl;
            gl.activeTexture([gl.TEXTURE0, gl.TEXTURE1, gl.TEXTURE2][unit]);
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.uniform1i(gl.getUniformLocation(program, samplerName), unit);
        }
        fill(width, height, data) {
            const gl = this.gl;
            gl.bindTexture(gl.TEXTURE_2D, this.texture);
            gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
            gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, data);
        }
    }

    /* eslint-disable no-unused-vars */
    /**
     * WebGL YUV420P renderer.
     *
     * Renders a YUV 4:2:0 planar frame onto a canvas via three luminance
     * textures (Y, U, V) and a YUV->RGB conversion in the fragment shader.
     *
     * The decoder may emit planes whose row stride is larger than the visible
     * width (alignment padding). When that happens we repack each row into a
     * tightly-packed `width * height` buffer before uploading, otherwise the
     * texture would sample padding bytes and the picture would shear.
     */
    var _WebGlRender_instances, _a, _WebGlRender_createProgram, _WebGlRender_packPlane, _WebGlRender_webglcontextlostFun, _WebGlRender_webglcontextrestoredFun, _WebGlRender_addEventListeners, _WebGlRender_removeEventListener;
    class WebGlRender {
        constructor(canvas, options = {}) {
            _WebGlRender_instances.add(this);
            const contextAttributes = Object.assign({
                antialias: false,
                alpha: false,
                preserveDrawingBuffer: false,
            }, options);
            const gl = canvas.getContext("webgl", contextAttributes) || canvas.getContext("experimental-webgl", contextAttributes);
            if (!gl) {
                throw new Error("WebGL not supported in this browser.");
            }
            this.gl = gl;
            this.canvas = canvas;
            __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_addEventListeners).call(this);
            this.program = __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_createProgram).call(this);
            this.verticesBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1.0, 1.0, 0.0, -1, 1.0, 0.0, 1.0, -1, 0.0, -1, -1, 0.0]), gl.STATIC_DRAW);
            const vertexPositionAttribute = gl.getAttribLocation(this.program, "aVertexPosition");
            gl.enableVertexAttribArray(vertexPositionAttribute);
            gl.vertexAttribPointer(vertexPositionAttribute, 3, gl.FLOAT, false, 0, 0);
            this.texCoordBuffer = gl.createBuffer();
            gl.bindBuffer(gl.ARRAY_BUFFER, this.texCoordBuffer);
            gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1.0, 0.0, 0.0, 0.0, 1.0, 1.0, 0.0, 1.0]), gl.STATIC_DRAW);
            const textureCoordAttribute = gl.getAttribLocation(this.program, "aTextureCoord");
            gl.enableVertexAttribArray(textureCoordAttribute);
            gl.vertexAttribPointer(textureCoordAttribute, 2, gl.FLOAT, false, 0, 0);
            this.yTexture = new Texture(gl);
            this.uTexture = new Texture(gl);
            this.vTexture = new Texture(gl);
            this.yTexture.bind(0, this.program, "YTexture");
            this.uTexture.bind(1, this.program, "UTexture");
            this.vTexture.bind(2, this.program, "VTexture");
            // Reusable scratch buffers for stride repacking; grow on demand.
            this._yScratch = null;
            this._uScratch = null;
            this._vScratch = null;
        }
        /**
         * Render a YUV420P frame coming from the WASM decoder.
         *
         * @param {IYUV420PFrame} frame
         */
        renderYuv420(frame) {
            const { width, height, y, u, v, yStride, uStride, vStride } = frame;
            const cw = width >> 1;
            const ch = height >> 1;
            const yPacked = __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_packPlane).call(this, y, width, height, yStride, "_yScratch");
            const uPacked = __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_packPlane).call(this, u, cw, ch, uStride, "_uScratch");
            const vPacked = __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_packPlane).call(this, v, cw, ch, vStride, "_vScratch");
            const gl = this.gl;
            gl.viewport(0, 0, this.canvas.width, this.canvas.height);
            gl.clearColor(0.0, 0.0, 0.0, 0.0);
            gl.clear(gl.COLOR_BUFFER_BIT);
            this.yTexture.fill(width, height, yPacked);
            this.uTexture.fill(cw, ch, uPacked);
            this.vTexture.fill(cw, ch, vPacked);
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }
        destroy() {
            try {
                const gl = this.gl;
                gl.deleteProgram(this.program);
                gl.deleteBuffer(this.verticesBuffer);
                gl.deleteBuffer(this.texCoordBuffer);
                gl.deleteTexture(this.yTexture.texture);
                gl.deleteTexture(this.uTexture.texture);
                gl.deleteTexture(this.vTexture.texture);
                __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_removeEventListener).call(this);
                this.verticesBuffer = null;
                this.texCoordBuffer = null;
                this._yScratch = null;
                this._uScratch = null;
                this._vScratch = null;
            }
            catch (err) {
                console.log("webgl destroyContext fail", err);
            }
        }
    }
    _a = WebGlRender, _WebGlRender_instances = new WeakSet(), _WebGlRender_createProgram = function _WebGlRender_createProgram() {
        const gl = this.gl;
        const vs = gl.createShader(gl.VERTEX_SHADER);
        if (!vs) {
            throw new Error("Failed to create vertex shader");
        }
        gl.shaderSource(vs, _a.VERTEX_SHADER_SOURCE);
        gl.compileShader(vs);
        if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(vs) || "Vertex shader compile failed");
        }
        const fs = gl.createShader(gl.FRAGMENT_SHADER);
        if (!fs) {
            throw new Error("Failed to create fragment shader");
        }
        gl.shaderSource(fs, _a.FRAGMENT_SHADER_SOURCE);
        gl.compileShader(fs);
        if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
            throw new Error(gl.getShaderInfoLog(fs) || "Fragment shader compile failed");
        }
        const program = gl.createProgram();
        if (!program) {
            throw new Error("Failed to create WebGL program");
        }
        gl.attachShader(program, vs);
        gl.attachShader(program, fs);
        gl.linkProgram(program);
        if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
            throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
        }
        gl.useProgram(program);
        return program;
    }, _WebGlRender_packPlane = function _WebGlRender_packPlane(data, width, height, stride, scratchKey) {
        if (stride === width) {
            // Already tight; upload as-is.
            return data;
        }
        const need = width * height;
        let scratch = this[scratchKey];
        if (!scratch || scratch.length < need) {
            scratch = new Uint8Array(need);
            this[scratchKey] = scratch;
        }
        for (let row = 0; row < height; row += 1) {
            scratch.set(data.subarray(row * stride, row * stride + width), row * width);
        }
        return scratch.length === need ? scratch : scratch.subarray(0, need);
    }, _WebGlRender_webglcontextlostFun = function _WebGlRender_webglcontextlostFun(e) {
        e.preventDefault(); // 阻止浏览器默认处理
        console.log("WebGL 上下文丢失，等待恢复");
    }, _WebGlRender_webglcontextrestoredFun = function _WebGlRender_webglcontextrestoredFun(_e) {
        console.log("WebGL 上下文恢复，重新初始化资源");
        // 重新创建着色器、纹理、缓冲区等
        // initWebGLResources();
    }, _WebGlRender_addEventListeners = function _WebGlRender_addEventListeners() {
        this.canvas.addEventListener("webglcontextlost", __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_webglcontextlostFun));
        this.canvas.addEventListener("webglcontextrestored", __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_webglcontextrestoredFun));
    }, _WebGlRender_removeEventListener = function _WebGlRender_removeEventListener() {
        this.canvas.removeEventListener("webglcontextlost", __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_webglcontextlostFun));
        this.canvas.removeEventListener("webglcontextrestored", __classPrivateFieldGet(this, _WebGlRender_instances, "m", _WebGlRender_webglcontextrestoredFun));
    };
    WebGlRender.VERTEX_SHADER_SOURCE = [
        "attribute highp vec4 aVertexPosition;",
        "attribute vec2 aTextureCoord;",
        "varying highp vec2 vTextureCoord;",
        "void main(void) {",
        "  gl_Position = aVertexPosition;",
        "  vTextureCoord = aTextureCoord;",
        "}",
    ].join("\n");
    WebGlRender.FRAGMENT_SHADER_SOURCE = [
        "precision highp float;",
        "varying lowp vec2 vTextureCoord;",
        "uniform sampler2D YTexture;",
        "uniform sampler2D UTexture;",
        "uniform sampler2D VTexture;",
        "const mat4 YUV2RGB = mat4(",
        "  1.1643828125,  0.0,           1.59602734375, -0.87078515625,",
        "  1.1643828125, -0.39176171875,-0.81296875,     0.52959375,",
        "  1.1643828125,  2.017234375,   0.0,           -1.081390625,",
        "  0.0,           0.0,           0.0,            1.0",
        ");",
        "void main(void) {",
        "  gl_FragColor = vec4(",
        "    texture2D(YTexture, vTextureCoord).x,",
        "    texture2D(UTexture, vTextureCoord).x,",
        "    texture2D(VTexture, vTextureCoord).x,",
        "    1.0",
        "  ) * YUV2RGB;",
        "}",
    ].join("\n");

    class AudioRenderer {
        constructor() {
            this.audioContext = null;
            this.gainNode = null;
            this.startedAt = 0;
            this.nextPlayTime = 0;
            this.mediaOffsetSec = null;
            this._volume = 1.0;
            this._muted = false;
            this._playbackRate = 1.0;
            this._activeSources = []; // currently scheduled, not-yet-finished sources
            this._keepAliveOsc = null;
            this._keepAliveGain = null;
            this._unlockBound = null;
        }
        async init() {
            if (this.audioContext) {
                return this._tryResume();
            }
            this.audioContext = new AudioContext({ latencyHint: "interactive" });
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = this._muted ? 0 : this._volume;
            this.gainNode.connect(this.audioContext.destination);
            this.startedAt = this.audioContext.currentTime;
            this.nextPlayTime = this.startedAt;
            // Silent oscillator keeps the Web Audio graph active,
            // preventing iOS from suspending the AudioContext.
            this._startKeepAlive();
            // If iOS suspends the context (e.g. app background), auto-resume.
            this.audioContext.addEventListener("statechange", () => {
                if (this.audioContext && this.audioContext.state === "suspended") ;
            });
            // iOS requires a user gesture to start AudioContext.
            // Register a one-shot unlock on the first user interaction.
            this._unlockBound = () => this._tryResume();
            document.addEventListener("pointerdown", this._unlockBound, { once: true });
            document.addEventListener("touchend", this._unlockBound, { once: true });
            return this._tryResume();
        }
        async _tryResume() {
            if (!this.audioContext)
                return;
            if (this.audioContext.state !== "running") {
                try {
                    await this.audioContext.resume();
                }
                catch (_) {
                    // Resuming without a user gesture may be rejected on iOS.
                    // The unlock handler will retry on first interaction.
                }
            }
        }
        /** Silent oscillator → gain=0 → destination. Keeps AudioContext running. */
        _startKeepAlive() {
            if (!this.audioContext)
                return;
            this._keepAliveOsc = this.audioContext.createOscillator();
            this._keepAliveGain = this.audioContext.createGain();
            this._keepAliveGain.gain.value = 0;
            this._keepAliveOsc.connect(this._keepAliveGain);
            this._keepAliveGain.connect(this.audioContext.destination);
            this._keepAliveOsc.frequency.value = 440;
            this._keepAliveOsc.start();
        }
        /* ---------------- API exposed to the player ---------------- */
        setVolume(v) {
            this._volume = Math.max(0, Math.min(1, +v || 0));
            if (this.gainNode) {
                this.gainNode.gain.value = this._muted ? 0 : this._volume;
            }
        }
        setMuted(m) {
            this._muted = !!m;
            if (this.gainNode) {
                this.gainNode.gain.value = this._muted ? 0 : this._volume;
            }
        }
        setPlaybackRate(rate) {
            const r = Math.max(0.25, Math.min(4, +rate || 1));
            const prevRate = this._playbackRate;
            if (r === prevRate)
                return;
            this._playbackRate = r;
            // Apply rate to active sources AND recalculate nextPlayTime.
            // Without recalculating, the next enqueueFrame would schedule at
            // the old nextPlayTime, causing audio gaps or overlaps.
            const now = this.audioContext ? this.audioContext.currentTime : 0;
            let recalculatedNext = now + 0.02;
            for (const s of this._activeSources) {
                try {
                    s.playbackRate.value = r;
                    // Each source carries _startAt and its buffer duration so we can
                    // re-derive the effective end time after the rate change.
                    if (s._startAt != null && s.buffer) {
                        const newEndsAt = s._startAt + s.buffer.duration / r;
                        s._endsAt = newEndsAt;
                        recalculatedNext = Math.max(recalculatedNext, newEndsAt);
                    }
                }
                catch (_) {
                    // already finished
                }
            }
            this.nextPlayTime = recalculatedNext;
        }
        async suspend() {
            if (this.audioContext && this.audioContext.state === "running") {
                try {
                    await this.audioContext.suspend();
                }
                catch (_) {
                    /* ignore */
                }
            }
        }
        async resume() {
            if (this.audioContext && this.audioContext.state !== "running") {
                try {
                    await this.audioContext.resume();
                }
                catch (_) {
                    /* ignore */
                }
            }
        }
        /* ---------------- Frame ingestion ---------------- */
        enqueueFrame(frame) {
            if (!this.audioContext || !this.gainNode) {
                return;
            }
            const { channels, sampleRate, sampleCount, pcm, ptsMs } = frame;
            const audioBuffer = this.audioContext.createBuffer(channels, sampleCount, sampleRate);
            for (let ch = 0; ch < channels; ch += 1) {
                const channelData = audioBuffer.getChannelData(ch);
                for (let i = 0; i < sampleCount; i += 1) {
                    channelData[i] = pcm[i * channels + ch];
                }
            }
            const source = this.audioContext.createBufferSource();
            source.buffer = audioBuffer;
            source.playbackRate.value = this._playbackRate;
            source.connect(this.gainNode);
            const now = this.audioContext.currentTime;
            const startAt = Math.max(this.nextPlayTime, now + 0.02);
            if (this.mediaOffsetSec === null && Number.isFinite(ptsMs)) {
                this.mediaOffsetSec = ptsMs / 1000 - startAt;
            }
            source.start(startAt);
            source._startAt = startAt;
            const effectiveDuration = audioBuffer.duration / this._playbackRate;
            const endsAt = startAt + effectiveDuration;
            source._endsAt = endsAt;
            this._activeSources.push(source);
            source.onended = () => {
                const idx = this._activeSources.indexOf(source);
                if (idx >= 0)
                    this._activeSources.splice(idx, 1);
            };
            this.nextPlayTime = endsAt;
        }
        /* ---------------- Clock helpers ---------------- */
        getBufferedSeconds() {
            if (!this.audioContext) {
                return 0;
            }
            return Math.max(0, this.nextPlayTime - this.audioContext.currentTime);
        }
        getMediaTimeSec() {
            if (!this.audioContext || this.mediaOffsetSec === null) {
                return null;
            }
            return this.audioContext.currentTime + this.mediaOffsetSec;
        }
        reset() {
            for (const s of this._activeSources) {
                try {
                    s.stop();
                    s.disconnect();
                }
                catch (_) {
                    /* already finished */
                }
            }
            this._activeSources.length = 0;
            this.nextPlayTime = this.audioContext ? this.audioContext.currentTime : 0;
            this.mediaOffsetSec = null;
        }
        destroy() {
            this.reset();
            if (this._keepAliveOsc) {
                try {
                    this._keepAliveOsc.stop();
                }
                catch (_) {
                    /* already stopped */
                }
                this._keepAliveOsc.disconnect();
                this._keepAliveOsc = null;
            }
            if (this._keepAliveGain) {
                this._keepAliveGain.disconnect();
                this._keepAliveGain = null;
            }
            if (this.gainNode) {
                this.gainNode.disconnect();
                this.gainNode = null;
            }
            if (this._unlockBound) {
                document.removeEventListener("pointerdown", this._unlockBound);
                document.removeEventListener("touchend", this._unlockBound);
                this._unlockBound = null;
            }
            if (this.audioContext) {
                this.audioContext.close();
                this.audioContext = null;
            }
        }
    }

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
    /* ----------------------------- box helpers ----------------------------- */
    function readU32(b, p) {
        return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0;
    }
    /** Iterate boxes between [start, end). Handles 64-bit largesize. */
    function boxes(b, start, end) {
        const out = [];
        let p = start;
        while (p + 8 <= end) {
            let size = readU32(b, p);
            const type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
            let headerLen = 8;
            if (size === 1) {
                // 64-bit size; we ignore the high 32 bits (segments are small).
                size = readU32(b, p + 12);
                headerLen = 16;
            }
            else if (size === 0) {
                size = end - p; // extends to end
            }
            if (size < headerLen || p + size > end)
                break;
            out.push({ type, start: p + headerLen, end: p + size });
            p += size;
        }
        return out;
    }
    function findFirst(b, start, end, type) {
        for (const box of boxes(b, start, end)) {
            if (box.type === type)
                return box;
        }
        return null;
    }
    /* --------------------------- ASC (from init) --------------------------- */
    function readDescriptorLen(b, pos) {
        let len = 0;
        let count = 0;
        let byte;
        do {
            byte = b[pos++];
            len = (len << 7) | (byte & 0x7f);
            count += 1;
        } while (byte & 0x80 && count < 4);
        return { len, pos };
    }
    /** Pull the AudioSpecificConfig bytes out of an `esds` box content. */
    function ascFromEsds(esds) {
        let p = 4; // skip version + flags (fullbox)
        if (esds[p] === 0x03) {
            // ES_Descriptor
            p += 1;
            p = readDescriptorLen(esds, p).pos;
            p += 2; // ES_ID
            const flags = esds[p];
            p += 1;
            if (flags & 0x80)
                p += 2; // dependsOn ES_ID
            if (flags & 0x40) {
                const urlLen = esds[p];
                p += 1 + urlLen;
            }
            if (flags & 0x20)
                p += 2; // OCR ES_ID
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
    function parseAsc(asc) {
        let bitPos = 0;
        const readBits = (n) => {
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
        if (aot === 31)
            aot = 32 + readBits(6);
        let freqIndex = readBits(4);
        let sampleRate;
        if (freqIndex === 15) {
            sampleRate = readBits(24);
            // Map explicit rate back to the nearest ADTS table index.
            freqIndex = nearestFreqIndex(sampleRate);
        }
        else {
            sampleRate = ADTS_FREQ_TABLE[freqIndex] || 44100;
        }
        const channelConfig = readBits(4);
        return { audioObjectType: aot, samplingFrequencyIndex: freqIndex, sampleRate, channelConfig };
    }
    function nearestFreqIndex(rate) {
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
    function parseAudioInit(initBytes) {
        const len = initBytes.length;
        const moov = findFirst(initBytes, 0, len, "moov");
        if (!moov)
            return null;
        const trak = findFirst(initBytes, moov.start, moov.end, "trak");
        if (!trak)
            return null;
        const mdia = findFirst(initBytes, trak.start, trak.end, "mdia");
        if (!mdia)
            return null;
        const minf = findFirst(initBytes, mdia.start, mdia.end, "minf");
        if (!minf)
            return null;
        const stbl = findFirst(initBytes, minf.start, minf.end, "stbl");
        if (!stbl)
            return null;
        const stsd = findFirst(initBytes, stbl.start, stbl.end, "stsd");
        if (!stsd)
            return null;
        // stsd is a fullbox: 4 bytes version/flags + 4 bytes entry_count, then entries.
        const entriesStart = stsd.start + 8;
        const sampleEntry = boxes(initBytes, entriesStart, stsd.end)[0];
        if (!sampleEntry)
            return null;
        if (sampleEntry.type !== "mp4a" && sampleEntry.type !== "enca") {
            // Not AAC in an mp4a entry; caller may fall back.
            return null;
        }
        // AudioSampleEntry: 28 bytes of fixed fields after the box header, then
        // child boxes (esds). sampleEntry.start already points past the 8-byte header.
        const childStart = sampleEntry.start + 28;
        const esds = findFirst(initBytes, childStart, sampleEntry.end, "esds");
        if (!esds)
            return null;
        const asc = ascFromEsds(initBytes.slice(esds.start, esds.end));
        if (!asc || asc.length < 2)
            return null;
        return parseAsc(asc);
    }
    /* ------------------------- media → ADTS frames ------------------------- */
    /** Collect per-sample byte sizes from a moof's traf(s). */
    function sampleSizesFromMoof(b, moof) {
        const sizes = [];
        for (const traf of boxes(b, moof.start, moof.end)) {
            if (traf.type !== "traf")
                continue;
            let defaultSampleSize = 0;
            const tfhd = findFirst(b, traf.start, traf.end, "tfhd");
            if (tfhd) {
                // fullbox: 1 byte version + 3 bytes flags
                const flags = ((b[tfhd.start + 1] << 16) | (b[tfhd.start + 2] << 8) | b[tfhd.start + 3]) >>> 0;
                let p = tfhd.start + 4 + 4; // skip version/flags + track_ID
                if (flags & 0x000001)
                    p += 8; // base-data-offset
                if (flags & 0x000002)
                    p += 4; // sample-description-index
                if (flags & 0x000008)
                    p += 4; // default-sample-duration
                if (flags & 0x000010) {
                    defaultSampleSize = readU32(b, p);
                    p += 4;
                }
                // default-sample-flags (0x000020) ignored
            }
            const trun = findFirst(b, traf.start, traf.end, "trun");
            if (!trun)
                continue;
            const flags = ((b[trun.start + 1] << 16) | (b[trun.start + 2] << 8) | b[trun.start + 3]) >>> 0;
            let p = trun.start + 4; // skip version/flags
            const sampleCount = readU32(b, p);
            p += 4;
            if (flags & 0x000001)
                p += 4; // data-offset
            if (flags & 0x000004)
                p += 4; // first-sample-flags
            const hasDuration = (flags & 0x000100) !== 0;
            const hasSize = (flags & 0x000200) !== 0;
            const hasFlags = (flags & 0x000400) !== 0;
            const hasCto = (flags & 0x000800) !== 0;
            for (let i = 0; i < sampleCount; i += 1) {
                if (hasDuration)
                    p += 4;
                let size = defaultSampleSize;
                if (hasSize) {
                    size = readU32(b, p);
                    p += 4;
                }
                if (hasFlags)
                    p += 4;
                if (hasCto)
                    p += 4;
                sizes.push(size);
            }
        }
        return sizes;
    }
    function makeAdtsHeader(cfg, frameLen) {
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
    function fmp4ToAdts(mediaBytes, cfg) {
        const len = mediaBytes.length;
        const top = boxes(mediaBytes, 0, len);
        const chunks = [];
        let pendingSizes = null;
        for (const box of top) {
            if (box.type === "moof") {
                pendingSizes = sampleSizesFromMoof(mediaBytes, box);
            }
            else if (box.type === "mdat" && pendingSizes) {
                let p = box.start;
                for (const size of pendingSizes) {
                    if (size <= 0 || p + size > box.end)
                        break;
                    const frame = mediaBytes.subarray(p, p + size);
                    p += size;
                    chunks.push(makeAdtsHeader(cfg, frame.length));
                    chunks.push(frame);
                }
                pendingSizes = null;
            }
        }
        if (chunks.length === 0)
            return null;
        let total = 0;
        for (const c of chunks)
            total += c.length;
        const out = new Uint8Array(total);
        let off = 0;
        for (const c of chunks) {
            out.set(c, off);
            off += c.length;
        }
        return out;
    }

    /**
     * Mp4AudioDecoder — decodes a standalone fMP4 / CMAF AAC audio track using the
     * browser's native `AudioContext.decodeAudioData`, without a second WASM
     * decoder.
     *
     * Approach
     * --------
     * We do NOT feed fragmented MP4 to decodeAudioData (its `moov` has no sample
     * table and the fragmented duration is often "unknown", which makes the native
     * decoder attempt a huge output allocation → "Array buffer allocation failed").
     *
     * Instead we:
     *   1. Parse the audio init segment once to recover the AAC config
     *      (AudioObjectType, sample rate, channel count) from `esds`.
     *   2. For each media segment, walk `moof/trun` to get per-sample sizes, slice
     *      the raw AAC access units out of `mdat`, and wrap each in an ADTS header.
     *   3. Hand the concatenated ADTS stream to decodeAudioData, which decodes
     *      self-describing ADTS reliably and allocates a correctly-sized buffer.
     *
     * PTS is derived by accumulating decoded durations from the first segment;
     * CMAF keeps audio and video timelines aligned, so this monotonic clock tracks
     * the video PTS closely enough for A/V sync (the AudioRenderer then schedules
     * buffers gaplessly).
     */
    class Mp4AudioDecoder {
        constructor(audioContext, onPcm, onError) {
            this.audioContext = audioContext;
            this.onPcm = onPcm;
            this.onError = onError || (() => { });
            /** @type {Uint8Array | null} raw init segment (ftyp+moov). */
            this._initSegment = null;
            /** @type {import("./fmp4_aac").AacConfig | null} */
            this._aacConfig = null;
            this._timelineSec = 0;
            this._started = false;
            this._decodeChain = Promise.resolve();
            this._disposed = false;
            this._failCount = 0;
        }
        setAudioContext(audioContext) {
            this.audioContext = audioContext;
        }
        /** Store + parse the audio init segment (ftyp+moov). */
        setInitSegment(bytes) {
            this._initSegment = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            try {
                this._aacConfig = parseAudioInit(this._initSegment);
                if (!this._aacConfig) {
                    this.onError(new Error("audio init: not an AAC/mp4a track or esds not found"));
                }
            }
            catch (err) {
                this._aacConfig = null;
                const msg = err instanceof Error ? err.message : String(err);
                this.onError(new Error(`audio init parse failed: ${msg}`));
            }
        }
        hasInit() {
            return this._aacConfig !== null;
        }
        /** Feed one media segment (moof+mdat). Decoding is serialized to keep order. */
        feedSegment(bytes) {
            const media = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
            this._decodeChain = this._decodeChain
                .then(() => this._decodeOne(media))
                .catch((err) => {
                console.error("[mp4-audio] decode failed:", err);
            });
            return this._decodeChain;
        }
        async _decodeOne(media) {
            if (this._disposed || !this.audioContext)
                return;
            if (!this._aacConfig) {
                // Init not parsed yet (or not AAC). Drop this segment.
                return;
            }
            const adts = fmp4ToAdts(media, this._aacConfig);
            if (!adts || adts.length === 0) {
                this._reportFail("could not extract AAC frames from media segment");
                return;
            }
            // Copy into a standalone ArrayBuffer (decodeAudioData detaches it).
            const buf = new Uint8Array(adts).buffer;
            let audioBuffer;
            try {
                audioBuffer = await this.audioContext.decodeAudioData(buf);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this._reportFail(`decodeAudioData(ADTS) rejected: ${msg}`);
                return;
            }
            this._failCount = 0;
            if (this._disposed)
                return;
            const channels = audioBuffer.numberOfChannels;
            const sampleRate = audioBuffer.sampleRate;
            const sampleCount = audioBuffer.length;
            const pcm = new Float32Array(sampleCount * channels);
            for (let ch = 0; ch < channels; ch += 1) {
                const data = audioBuffer.getChannelData(ch);
                for (let i = 0; i < sampleCount; i += 1) {
                    pcm[i * channels + ch] = data[i];
                }
            }
            const ptsMs = this._timelineSec * 1000;
            this._timelineSec += audioBuffer.duration;
            this._started = true;
            this.onPcm({ channels, sampleRate, sampleCount, pcm, ptsMs });
        }
        _reportFail(msg) {
            this._failCount += 1;
            if (this._failCount <= 3) {
                this.onError(new Error(`${msg} (#${this._failCount})`));
            }
            console.warn("[mp4-audio]", msg);
        }
        /** Reset the timeline (e.g. on seek) but keep the init/config. */
        reset() {
            this._timelineSec = 0;
            this._started = false;
            this._failCount = 0;
            this._decodeChain = Promise.resolve();
        }
        /** Full reset including init/config (e.g. switching streams). */
        clear() {
            this.reset();
            this._initSegment = null;
            this._aacConfig = null;
        }
        dispose() {
            this._disposed = true;
            this.clear();
        }
    }

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
    function classifyPlaylist(text) {
        const hasStreamInf = /^#EXT-X-STREAM-INF[: ]/m.test(text);
        const hasExtinf = /^#EXTINF[: ]/m.test(text);
        // const type = /#EXT-X-PLAYLIST-TYPE:VOD/
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
    function parseMasterPlaylist(text, playlistUrl) {
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
    function selectVariantAndAudio(master) {
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
    function parseMediaPlaylist(text, playlistUrl) {
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
            // #EXT-X-PRELOAD-HINT 是 HLS Low-Latency（LL-HLS） 规范中的一个标签，用于提示播放器可以预取即将出现的下一个片段（part或segment），以进一步降低延迟。
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

    class Helper {
        /**
         * Per-track fetch loop state. Each track ("muxed" | "video" | "audio")
         * carries its own seen-set, init-loaded flag and abort controller.
         */
        // prettier-ignore
        static makeTrackState(kind, url) {
            return {
                kind,
                url,
                seen: new Set(),
                initLoaded: false,
                sleepResolve: null,
                running: false,
            };
        }
        /**
         * Merge two HeadersInit-ish values into a plain object.
         */
        static flattenHeaders(h) {
            const out = {};
            if (!h)
                return out;
            if (h instanceof Headers) {
                h.forEach((v, k) => {
                    out[k] = v;
                });
            }
            else if (Array.isArray(h)) {
                for (const [k, v] of h)
                    out[k] = v;
            }
            else {
                Object.assign(out, h);
            }
            return out;
        }
        static getPlaylistType(text) {
            if (/#EXT-X-ENDLIST/.test(text)) {
                return "vod";
            }
            else {
                return "live";
            }
        }
    }

    /**
     * Fetcher — thin HTTP client wrapping the Fetch API.
     *
     * Provides timeout, abort, CORS config, and custom RequestInit merging.
     * Does NOT contain retry logic — retry is handled by each caller.
     */
    const __$DEFAULT_FETCHER_OPTIONS$__ = {
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
    };
    class Fetcher {
        constructor(fetchOptions = {}, timeout = 30000) {
            this._fetchOptions = { ...__$DEFAULT_FETCHER_OPTIONS$__, ...fetchOptions };
            this._timeout = timeout;
            this._abortControllers = new Map();
        }
        /* ==================== Core Fetch ==================== */
        /**
         * Perform a single HTTP GET request. No retry.
         * Returns the raw Response (caller should consume .text() / .arrayBuffer()).
         */
        async fetch(url, options = {}) {
            const baseHeaders = Helper.flattenHeaders(this._fetchOptions.headers);
            const perReqHeaders = Helper.flattenHeaders(options.headers);
            const mergedHeaders = { ...baseHeaders, ...perReqHeaders };
            const mergedOptions = {
                ...this._fetchOptions,
                ...options,
                headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
            };
            const controller = new AbortController();
            if (!this._abortControllers.has(url)) {
                this._abortControllers.set(url, new Set());
            }
            this._abortControllers.get(url).add(controller);
            const externalSignal = options.signal;
            if (externalSignal) {
                if (externalSignal.aborted) {
                    controller.abort();
                }
                else {
                    externalSignal.addEventListener("abort", () => controller.abort(), { once: true });
                }
            }
            let timeoutId = null;
            const effectiveTimeout = options.timeout ?? this._timeout;
            if (effectiveTimeout > 0) {
                timeoutId = setTimeout(() => controller.abort(), effectiveTimeout);
            }
            try {
                const response = await fetch(url, {
                    ...mergedOptions,
                    signal: controller.signal,
                });
                if (!response.ok) {
                    const err = new Error(`HTTP ${response.status}: ${response.statusText}`);
                    err.status = response.status;
                    throw err;
                }
                return response;
            }
            finally {
                if (timeoutId)
                    clearTimeout(timeoutId);
                const set = this._abortControllers.get(url);
                if (set) {
                    set.delete(controller);
                    if (set.size === 0) {
                        this._abortControllers.delete(url);
                    }
                }
            }
        }
        /* ==================== Convenience helpers ==================== */
        async fetchText(url, options = {}) {
            const response = await this.fetch(url, options);
            const text = await response.text();
            return { text, url: response.url || url };
        }
        async fetchBytes(url, options = {}) {
            const response = await this.fetch(url, options);
            const data = await response.arrayBuffer();
            return new Uint8Array(data);
        }
        /* ==================== Abort ==================== */
        cancelRequest(url) {
            const set = this._abortControllers.get(url);
            if (set) {
                for (const controller of set) {
                    controller.abort();
                }
                this._abortControllers.delete(url);
            }
        }
        cancelAll() {
            for (const [, set] of this._abortControllers) {
                for (const controller of set) {
                    controller.abort();
                }
            }
            this._abortControllers.clear();
        }
        /* ==================== Config ==================== */
        setFetchOptions(options) {
            this._fetchOptions = { ...this._fetchOptions, ...options };
        }
    }

    /* eslint-disable no-unused-vars */
    class HlsController {
        constructor({ lowLatencyMode = true, followRedirectUrl = true, requestInit = null, fetchTimeout = 30000, onSegment, onDuration, onError }) {
            // private
            this._getMapCount = 0;
            /** 防止多 #EXT-X-MAP:URI= */
            this.mapList = new Map();
            this.lowLatencyMode = lowLatencyMode;
            this.followRedirectUrl = followRedirectUrl;
            this.fetcher = new Fetcher(requestInit || {}, fetchTimeout);
            this.onSegment = onSegment;
            this.onDuration = onDuration || (() => { });
            this.onError = onError || (() => { });
            this.playlistUrl = "";
            this.originPlaylistUrl = "";
            this.totalDuration = 0;
            this.isMaster = false;
            this.tracks = [];
            this.enablePreloadHintFetch = false;
            this._onVisible = () => {
                if (document.visibilityState === "visible") {
                    for (const t of this.tracks) {
                        if (t.sleepResolve) {
                            t.sleepResolve();
                            t.sleepResolve = null;
                        }
                    }
                }
            };
        }
        /* -------------------- public lifecycle -------------------- */
        async start(playlistUrl) {
            this.playlistUrl = playlistUrl;
            this.originPlaylistUrl = playlistUrl;
            this._getMapCount = 0;
            this.mapList = new Map();
            document.addEventListener("visibilitychange", this._onVisible);
            let firstText;
            try {
                const result = await this.fetcher.fetchText(this.playlistUrl);
                firstText = result.text;
                // 重定向
                if (this.followRedirectUrl && result.url !== this.playlistUrl) {
                    this.playlistUrl = result.url;
                }
            }
            catch (err) {
                this.onError(err);
                document.removeEventListener("visibilitychange", this._onVisible);
                return;
            }
            const kind = classifyPlaylist(firstText);
            if (kind === "master") {
                this.isMaster = true;
                const master = parseMasterPlaylist(firstText, this.playlistUrl);
                const { variant, audio } = selectVariantAndAudio(master);
                if (!variant) {
                    const err = new Error("Master playlist has no variants");
                    this.onError(err);
                    document.removeEventListener("visibilitychange", this._onVisible);
                    return;
                }
                console.warn(`[hls] master playlist resolved: video=${variant.uri}` + (audio?.uri ? ` audio=${audio.uri}` : " audio=<none>"));
                const videoTrack = Helper.makeTrackState("video", variant.uri);
                this.tracks.push(videoTrack);
                if (audio?.uri) {
                    this.tracks.push(Helper.makeTrackState("audio", audio.uri));
                }
                await Promise.all(this.tracks.map((t) => this._loop(t)));
            }
            else {
                this.isMaster = false;
                this.playlistType = Helper.getPlaylistType(firstText);
                const muxedTrack = Helper.makeTrackState("muxed", this.playlistUrl);
                this.tracks.push(muxedTrack);
                if (this.playlistType === "vod") {
                    await this._getPartOrSegmentOrPreloadHint(firstText, muxedTrack);
                }
                else {
                    await this._loop(muxedTrack);
                }
            }
            document.removeEventListener("visibilitychange", this._onVisible);
        }
        async seek(targetTimeSec) {
            if (this.tracks.length === 0)
                return 0;
            for (const t of this.tracks)
                this._abortTrack(t);
            let primaryStart = 0;
            const restarts = [];
            for (const t of this.tracks) {
                const isPrimary = t.kind === "video" || t.kind === "muxed";
                const result = await this.fetcher.fetchText(t.url);
                const info = parseMediaPlaylist(result.text, t.url);
                let accumulated = 0;
                t.seen = new Set();
                for (const seg of info.segments) {
                    if (accumulated + seg.duration >= targetTimeSec)
                        break;
                    accumulated += seg.duration;
                    t.seen.add(seg.url);
                }
                t.initLoaded = false;
                if (targetTimeSec <= 0)
                    t.seen.clear();
                if (isPrimary)
                    primaryStart = accumulated;
                restarts.push(this._loop(t));
            }
            Promise.all(restarts).catch(() => { });
            return primaryStart;
        }
        stop() {
            for (const t of this.tracks)
                this._abortTrack(t);
            this.tracks.length = 0;
            this.fetcher.cancelAll();
            document.removeEventListener("visibilitychange", this._onVisible);
        }
        setLowLatencyMode(value) {
            this.lowLatencyMode = !!value;
        }
        /** Update the base RequestInit used for all subsequent fetches. */
        setRequestInit(requestInit) {
            this.fetcher.setFetchOptions(requestInit || {});
        }
        /* -------------------- internals -------------------- */
        _abortTrack(track) {
            track.running = false;
            if (track.url) {
                this.fetcher.cancelRequest(track.url);
            }
            if (track.sleepResolve) {
                track.sleepResolve();
                track.sleepResolve = null;
            }
        }
        async _loop(track) {
            track.running = true;
            while (track.running) {
                try {
                    const result = await this.fetcher.fetchText(track.url);
                    const info = await this._getPartOrSegmentOrPreloadHint(result.text, track);
                    if (this.playlistType === "vod" && info.isEndList)
                        break;
                    const reloadMs = this.lowLatencyMode && info.partTarget ? Math.max(150, info.partTarget * 500) : Math.max(500, info.targetDuration * 500);
                    await this._sleep(track, reloadMs);
                }
                catch (err) {
                    if (!track.running)
                        break;
                    console.error(`[hls] loop error [${track.kind}]:`, err);
                    this.onError(err);
                    await this._sleep(track, 500);
                }
            }
        }
        /**
         * 支持多个 MAP URI 的情况，虽然不太常见
         *
         * fMP4 格式的 HLS 播放 list 必须有 #EXT-X-MAP:URI=...，播放器必须先下载并加载该初始化段，后续所有 media segment 是基于此解码的
         * @param info
         * @param track
         */
        async _getMap(info, track) {
            const map = this.mapList.get(info.initSegment || "");
            if ((!map || !map?.loaded) && info.initSegment) {
                this._getMapCount++;
                try {
                    const initData = await this.fetcher.fetchBytes(info.initSegment);
                    this.mapList.set(info.initSegment, { loaded: true, data: initData });
                    await this.onSegment(initData, true, info.initSegment, track.kind);
                    return true;
                }
                catch (err) {
                    // 不加延时重试，避免 init segment 获取失败导致后续 segment 也无法获取
                    // 重试 3 次后放弃，避免死循环
                    if (this._getMapCount <= 3) {
                        return this._getMap(info, track);
                    }
                    else {
                        console.error(`[hls] failed to fetch init segment after 3 attempts: ${info.initSegment}`);
                        this.onError(err);
                        return false;
                    }
                }
            }
            return true;
        }
        async _getPartOrSegmentOrPreloadHint(text, track) {
            //
            const info = parseMediaPlaylist(text, track.url);
            if (track.kind === "video" || track.kind === "muxed") {
                this.playlistType = Helper.getPlaylistType(text);
            }
            const mapResult = await this._getMap(info, track);
            // 获取 init segment 失败，且重试达到上限，放弃继续获取该 track
            if (mapResult === false)
                throw new Error(`Failed to fetch init segment: ${info.initSegment}`);
            // url(part or segment) list
            const candidates = [];
            const shouldCountDuration = track.kind === "video" || track.kind === "muxed";
            const useParts = this.lowLatencyMode && info.parts.length > 0;
            if (useParts) {
                for (const part of info.parts) {
                    candidates.push(part.url);
                    if (track.seen.has(part.url))
                        continue;
                    if (shouldCountDuration && part.duration > 0) {
                        this.totalDuration += part.duration;
                        this.onDuration(this.totalDuration);
                    }
                }
            }
            else {
                for (const seg of info.segments) {
                    candidates.push(seg.url);
                    if (track.seen.has(seg.url))
                        continue;
                    if (shouldCountDuration && seg.duration > 0) {
                        this.totalDuration += seg.duration;
                        this.onDuration(this.totalDuration);
                    }
                }
            }
            if (this.enablePreloadHintFetch && useParts && info.preloadHint)
                candidates.push(info.preloadHint);
            for (const url of candidates) {
                if (track.seen.has(url))
                    continue;
                track.seen.add(url);
                try {
                    const bytes = await this.fetcher.fetchBytes(url);
                    await this.onSegment(bytes, false, url, track.kind);
                }
                catch (error) {
                    console.error(`[hls] failed to fetch segment: ${url}`, error);
                    this.onError(error);
                }
            }
            return info;
        }
        _sleep(track, ms) {
            return new Promise((resolve) => {
                const id = setTimeout(() => {
                    track.sleepResolve = null;
                    resolve();
                }, ms);
                track.sleepResolve = () => {
                    clearTimeout(id);
                    track.sleepResolve = null;
                    resolve();
                };
            });
        }
    }

    class PlaylistManager {
        constructor(player) {
            this.hls = null;
            this._totalDuration = 0;
            this.player = player;
        }
        get duration() {
            if (this.player._currentMode === "live" && !this._totalDuration) {
                return Infinity;
            }
            return this._totalDuration || 0;
        }
        start(url) {
            this._totalDuration = 0;
            this.hls = new HlsController({
                lowLatencyMode: true,
                onDuration: (dur) => {
                    const prev = this._totalDuration;
                    this._totalDuration = dur;
                    this.player._totalDuration = dur;
                    if (dur !== prev) {
                        this.player._emit("durationchange", { duration: this.duration });
                    }
                    if (!this.player._loadedMetadataFired) {
                        this.player._loadedMetadataFired = true;
                        this.player._emit("loadedmetadata", {
                            duration: this.duration,
                            width: this.player.canvas?.width,
                            height: this.player.canvas?.height,
                        });
                    }
                },
                onError: (err) => {
                    this.player._emit("error", {
                        message: err instanceof Error ? err.message : String(err),
                        error: err,
                    });
                },
                onSegment: async (bytes, isInitSegment, segmentUrl, trackKind) => {
                    if (trackKind === "audio") {
                        await this.player._waitForAudioFlowControl();
                        if (!this.player.running)
                            return;
                        this.player._hasSeparateAudioTrack = true;
                        if (!this.player.audioDecoder)
                            return;
                        if (isInitSegment) {
                            this.player.audioDecoder.setInitSegment(bytes);
                            this.player.log(`audio-init: ${segmentUrl}`);
                        }
                        else {
                            void this.player.audioDecoder.feedSegment(bytes);
                            this.player.log(`audio-seg: ${segmentUrl}`);
                        }
                        return;
                    }
                    await this.player._waitForFlowControl();
                    if (!this.player.running)
                        return;
                    if (!isInitSegment) {
                        this.player._beginSegmentInfo(segmentUrl, bytes.length);
                    }
                    this.player.wasm.feedSegment(bytes, isInitSegment);
                    this.player.log(`${isInitSegment ? "init" : "seg"}: ${segmentUrl}`);
                },
            });
            this.player.log(`Start playback: ${url}`);
            this.hls.start(url);
        }
        stop() {
            if (this.hls) {
                this.hls.stop();
                this.hls = null;
            }
        }
        async seek(timeSec) {
            if (this.hls) {
                return await this.hls.seek(timeSec);
            }
            return 0;
        }
        get isLowLatencyMode() {
            return this.hls ? this.hls.lowLatencyMode : false;
        }
        setLowLatencyMode(value) {
            if (!this.hls)
                return;
            if (typeof this.hls.setLowLatencyMode === "function") {
                this.hls.setLowLatencyMode(value);
            }
            else {
                this.hls.lowLatencyMode = value;
            }
        }
        get isLoaded() {
            return this.hls !== null;
        }
    }

    /* eslint-disable no-unused-vars */
    class WasmBridge {
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
                            onVideoFrame(payload.width, payload.height, null, payload.yStride, // We don't have pointers anymore, we pass arrays in player.js directly soon
                            null, payload.uStride, null, payload.vStride, payload.ptsMs, payload.fps, payload.isKeyFrame, payload.codecName, payload.y, payload.u, payload.v // Pass arrays to player.js
                            );
                            break;
                        case 'audioFrame':
                            onAudioFrame(payload.channels, payload.sampleRate, payload.sampleCount, null, payload.ptsMs, payload.codecName, payload.pcm // Pass Float32Array to player.js
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
            let bytesCopy;
            try {
                bytesCopy = new Uint8Array(bytes);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                throw new Error(`Failed to copy segment buffer (${bytes.length} bytes): ${msg}. ` +
                    `System may be under memory pressure.`);
            }
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

    /**
     * Lightweight TimeRanges polyfill matching the HTMLMediaElement.buffered shape.
     * Stores [start, end] seconds pairs.
     * @example
     * new TimeRangesLite([[0, 10], [20, 30]])
     *  .start(0) // 0
     *  .end(0)   // 10
     *
     */
    class TimeRangesLite {
        constructor(ranges) {
            this._ranges = ranges || [];
            Object.defineProperty(this, "length", {
                get: () => this._ranges.length,
            });
        }
        start(i) {
            if (i < 0 || i >= this._ranges.length) {
                throw new Error("TimeRanges index out of range");
            }
            return this._ranges[i][0];
        }
        end(i) {
            if (i < 0 || i >= this._ranges.length) {
                throw new Error("TimeRanges index out of range");
            }
            return this._ranges[i][1];
        }
    }

    var _HlsWasmPlayer_instances, _HlsWasmPlayer_maybeFallbackFromLowLatency, _HlsWasmPlayer_enqueueVideoFrame, _HlsWasmPlayer_startRenderLoop, _HlsWasmPlayer_maybeMarkEnded, _HlsWasmPlayer_startTimeUpdate, _HlsWasmPlayer_stopTimeUpdate, _HlsWasmPlayer_updatePlayingWaitingState, _HlsWasmPlayer_onVisibilityChange, _HlsWasmPlayer_openAvGate, _HlsWasmPlayer_getVideoLeadSec, _HlsWasmPlayer_normalizeVideoPts, _HlsWasmPlayer_normalizeAudioPts, _HlsWasmPlayer_logSegmentVideoInfo, _HlsWasmPlayer_logSegmentAudioInfo, _HlsWasmPlayer_flushSegmentInfo, _HlsWasmPlayer_flushHeadSegmentInfo, _HlsWasmPlayer_flushPendingSegmentInfos, _HlsWasmPlayer_compactSegmentInfoQueue, _HlsWasmPlayer_evictStaleSegmentInfos, _HlsWasmPlayer_shortSegmentName;
    class HlsWasmPlayer {
        constructor({ canvas, wasmJsUrl, wasmFileUrl, log, onIFrame }) {
            _HlsWasmPlayer_instances.add(this);
            this.audioDecoder = null;
            this._hasSeparateAudioTrack = false;
            this._avGateOpen = true;
            this._pendingAudioFrames = [];
            this._avGateTimer = 0;
            this.running = false;
            this._initPromise = null;
            this._initialized = false;
            this.videoQueue = [];
            this.videoClockOffsetSec = null;
            this.renderRafId = 0;
            this.maxVideoQueueSize = 600;
            this.videoQueueHighWatermark = 300;
            this.maxAudioBufferedSec = 3.0;
            this.maxVideoLeadSec = 1.2;
            this.dropLateFrameSec = 0.2;
            this.maxFrameDropsPerTick = 10;
            this.droppedVideoFrames = 0;
            this.lastDropLogAt = 0;
            this.lastVideoRawPtsMs = null;
            this.lastVideoNormPtsMs = null;
            this.videoFrameDurMs = 33.33;
            this.lastAudioRawPtsMs = null;
            this.lastAudioNormPtsMs = null;
            this.segmentSeq = 0;
            this.segmentInfoQueue = [];
            this.maxPendingSegmentInfo = 60;
            this.maxSegmentInfoAgeMs = 30000;
            this.hevcCompatFallbackTriggered = false;
            this._totalDuration = 0;
            this._seekBaseTime = 0;
            this._currentSrc = "";
            this._currentMode = "vod";
            this._paused = true;
            this._ended = false;
            this._volume = 1.0;
            this._muted = false;
            this._playbackRate = 1.0;
            this._lastRenderedFramePtsSec = null;
            this._timeUpdateTimerId = 0;
            this._lastEmittedTimeSec = -1;
            this._loadedMetadataFired = false;
            this._playingFired = false;
            this._waitingFired = false;
            this._lastDurationFired = -1;
            this._audioTrackWarned = false;
            this.canvas = canvas;
            this.log = log || (() => { });
            this.onIFrame = onIFrame;
            // Event delegate (HTMLMediaElement-style addEventListener / removeEventListener / dispatchEvent).
            this._events = new EventTarget();
            this.renderer = new WebGlRender(canvas);
            this.audio = new AudioRenderer();
            this.wasm = new WasmBridge({ wasmJsUrl, wasmFileUrl });
            // Standalone audio track (master/multivariant fMP4-AAC) is decoded by the
            // browser via AudioContext.decodeAudioData rather than WASM. Created lazily
            // once the audio AudioContext exists (after init()).
            this.audioDecoder = null;
            // True once a separate "audio" track has been observed for this session.
            this._hasSeparateAudioTrack = false;
            // A/V startup gate: in master mode the native audio decoder is much faster
            // than the WASM video decoder, so audio would start ~1-2s before the first
            // video frame and the render loop would drop all "late" early frames.
            // We hold decoded audio PCM until the first video frame is ready (or a
            // timeout fires for audio-only), so both clocks start at the same instant.
            this._avGateOpen = true;
            this._pendingAudioFrames = [];
            this._avGateTimer = 0;
            this.playlist = new PlaylistManager(this);
            this.running = false;
            this._initPromise = null;
            this._initialized = false;
            this.videoQueue = [];
            this.videoClockOffsetSec = null;
            this.renderRafId = 0;
            this.maxVideoQueueSize = 600;
            this.videoQueueHighWatermark = 300;
            this.maxAudioBufferedSec = 3.0;
            this.maxVideoLeadSec = 1.2;
            this.dropLateFrameSec = 0.2;
            this.maxFrameDropsPerTick = 10; // prevent massive frame-drop stalls
            this.droppedVideoFrames = 0;
            this.lastDropLogAt = 0;
            this.lastVideoRawPtsMs = null;
            this.lastVideoNormPtsMs = null;
            this.videoFrameDurMs = 33.33;
            this.lastAudioRawPtsMs = null;
            this.lastAudioNormPtsMs = null;
            this.segmentSeq = 0;
            this.segmentInfoQueue = [];
            this.maxPendingSegmentInfo = 60;
            this.maxSegmentInfoAgeMs = 30000; // evict entries older than 30s
            this.hevcCompatFallbackTriggered = false;
            this._totalDuration = 0;
            this._seekBaseTime = 0;
            // HTMLMediaElement-like state
            this._currentSrc = "";
            this._currentMode = "vod";
            this._paused = true;
            this._ended = false;
            this._volume = 1.0;
            this._muted = false;
            this._playbackRate = 1.0;
            // PTS of the most recently rendered video frame (seconds, normalized).
            this._lastRenderedFramePtsSec = null;
            // Visibility-change handler for tab-background detection
            this._onVisibilityBound = () => __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_onVisibilityChange).call(this);
            // Event-emission bookkeeping
            this._timeUpdateTimerId = 0;
            this._lastEmittedTimeSec = -1;
            this._loadedMetadataFired = false;
            this._playingFired = false;
            this._waitingFired = false;
            this._lastDurationFired = -1;
            this._audioTrackWarned = false;
        }
        /* ============================================================== */
        /* Event API (HTMLMediaElement-style)                              */
        /* ============================================================== */
        addEventListener(type, listener, options) {
            return this._events.addEventListener(type, listener, options);
        }
        removeEventListener(type, listener, options) {
            return this._events.removeEventListener(type, listener, options);
        }
        dispatchEvent(event) {
            return this._events.dispatchEvent(event);
        }
        _emit(type, detail) {
            try {
                this._events.dispatchEvent(new CustomEvent(type, { detail }));
            }
            catch (err) {
                console.error(`[player] listener for "${type}" threw:`, err);
            }
        }
        /* ============================================================== */
        /* HTMLMediaElement-style properties                                */
        /* ============================================================== */
        /** Current playback position in seconds, sourced from rendered video frame. */
        get currentTime() {
            if (this._lastRenderedFramePtsSec !== null) {
                return this._lastRenderedFramePtsSec + this._seekBaseTime;
            }
            return this._seekBaseTime || 0;
        }
        set currentTime(t) {
            const sec = +t || 0;
            void this.seek(sec);
        }
        /** Total duration in seconds (from playlist), or Infinity for live. */
        get duration() {
            if (this._currentMode === "live" && !this._totalDuration) {
                return Infinity;
            }
            return this._totalDuration || 0;
        }
        get muted() {
            return this._muted;
        }
        set muted(v) {
            const next = !!v;
            if (next === this._muted)
                return;
            this._muted = next;
            this.audio.setMuted(this._muted);
            this._emit("volumechange", { volume: this._volume, muted: this._muted });
        }
        get volume() {
            return this._volume;
        }
        set volume(v) {
            const clamped = Math.max(0, Math.min(1, +v || 0));
            if (clamped === this._volume)
                return;
            this._volume = clamped;
            this.audio.setVolume(clamped);
            this._emit("volumechange", { volume: this._volume, muted: this._muted });
        }
        get playbackRate() {
            return this._playbackRate;
        }
        set playbackRate(r) {
            const clamped = Math.max(0.25, Math.min(4, +r || 1));
            if (clamped === this._playbackRate)
                return;
            this._playbackRate = clamped;
            this.audio.setPlaybackRate(clamped);
            this._emit("ratechange", { playbackRate: this._playbackRate });
        }
        /** True once VOD playback has reached the end of the playlist timeline. */
        get ended() {
            return this._ended;
        }
        get paused() {
            return this._paused;
        }
        /**
         * TimeRanges of buffered media, mimicking HTMLMediaElement.buffered.
         * Approximation: [currentTime, currentTime + audioBuffered + videoLead].
         */
        get buffered() {
            const cur = this.currentTime;
            const audioAhead = this.audio.getBufferedSeconds();
            const videoAhead = __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_getVideoLeadSec).call(this);
            const ahead = Math.max(audioAhead, videoAhead);
            if (ahead <= 0 && this.videoQueue.length === 0) {
                return new TimeRangesLite([]);
            }
            return new TimeRangesLite([[cur, cur + ahead]]);
        }
        /* ============================================================== */
        /* Lifecycle                                                       */
        /* ============================================================== */
        async init() {
            if (this._initPromise) {
                return this._initPromise;
            }
            this._initPromise = (async () => {
                await this.audio.init();
                this.audio.setVolume(this._volume);
                this.audio.setMuted(this._muted);
                this.audio.setPlaybackRate(this._playbackRate);
                // Native browser decoder for a standalone fMP4-AAC audio track
                // (master/multivariant playlists). Decoded PCM feeds the same
                // AudioRenderer used by the WASM audio path, so the audio clock and
                // A/V sync logic stay identical regardless of decode source.
                this.audioDecoder = new Mp4AudioDecoder(this.audio.audioContext, (frame) => {
                    this._emitAudioFrame(frame);
                }, (err) => {
                    this.log(`[audio] ${err.message}`);
                });
                await this.wasm.init({
                    onVideoFrame: (width, height, yPtr, yStride, uPtr, uStride, vPtr, vStride, ptsMs, fps, isKeyFrame, codecName, yData, uData, vData) => {
                        const y = yData;
                        const u = uData;
                        const v = vData;
                        const normalizedPtsMs = __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_normalizeVideoPts).call(this, ptsMs);
                        const normalizedFps = Number.isFinite(fps) && fps > 0 ? fps : 0;
                        if (normalizedFps > 0) {
                            this.videoFrameDurMs = 1000 / normalizedFps;
                        }
                        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_enqueueVideoFrame).call(this, {
                            width,
                            height,
                            y,
                            u,
                            v,
                            yStride,
                            uStride,
                            vStride,
                            ptsMs: normalizedPtsMs,
                            isKeyFrame: !!isKeyFrame,
                        });
                        if (isKeyFrame && this.onIFrame) {
                            this.onIFrame(normalizedPtsMs);
                        }
                        // First video frame is ready → release any audio held by the A/V gate
                        // so audio and video clocks start together.
                        if (!this._avGateOpen) {
                            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_openAvGate).call(this);
                        }
                        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_logSegmentVideoInfo).call(this, width, height, yStride, uStride, vStride, normalizedPtsMs, normalizedFps, codecName);
                    },
                    onAudioFrame: (channels, sampleRate, sampleCount, dataPtr, ptsMs, codecName, pcmData) => {
                        const pcm = pcmData;
                        const normalizedPtsMs = __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_normalizeAudioPts).call(this, ptsMs, sampleCount, sampleRate);
                        this.audio.enqueueFrame({
                            channels,
                            sampleRate,
                            sampleCount,
                            pcm,
                            ptsMs: normalizedPtsMs,
                        });
                        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_logSegmentAudioInfo).call(this, channels, sampleRate, sampleCount, normalizedPtsMs, codecName);
                    },
                    onLog: (level, msg) => {
                        this.log(`[wasm:${level}] ${msg}`);
                        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_maybeFallbackFromLowLatency).call(this, msg);
                    },
                });
                this._initialized = true;
                this.log("WASM module initialized successfully.");
            })();
            return this._initPromise;
        }
        async start(url, mode = "vod") {
            if (!this._initialized && this._initPromise) {
                this.log("Waiting for WASM initialization...");
                await this._initPromise;
            }
            if (!this._initialized) {
                throw new Error("WASM player has not been initialized. Call init() first.");
            }
            if (this.running) {
                await this.stop();
            }
            this._currentSrc = url;
            this._currentMode = mode || "vod";
            this._ended = false;
            this._paused = false;
            this._loadedMetadataFired = false;
            this._playingFired = false;
            this._waitingFired = false;
            this._lastDurationFired = -1;
            this._lastEmittedTimeSec = -1;
            this._audioTrackWarned = false;
            // Arm the A/V startup gate: hold decoded audio until the first video
            // frame renders (or the timeout fires). Released in #openAvGate.
            this._avGateOpen = false;
            this._pendingAudioFrames.length = 0;
            if (this._avGateTimer) {
                clearTimeout(this._avGateTimer);
                this._avGateTimer = 0;
            }
            // Fallback: if no video frame arrives (audio-only stream or very slow
            // video), open the gate after 2s so audio is never stuck silent.
            this._avGateTimer = window.setTimeout(() => __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_openAvGate).call(this), 2000);
            this._emit("loadstart", { src: url, mode: this._currentMode });
            this.hevcCompatFallbackTriggered = false;
            this.running = true;
            this.videoQueue.length = 0;
            this.videoClockOffsetSec = null;
            this.droppedVideoFrames = 0;
            this.lastDropLogAt = 0;
            this.lastVideoRawPtsMs = null;
            this.lastVideoNormPtsMs = null;
            this.videoFrameDurMs = 33.33;
            this.lastAudioRawPtsMs = null;
            this.lastAudioNormPtsMs = null;
            this.segmentInfoQueue.length = 0;
            this._lastRenderedFramePtsSec = null;
            this._seekBaseTime = 0;
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_startRenderLoop).call(this);
            // Listen for tab background/foreground transitions to
            // prevent massive frame-drop storms when rAF was suspended.
            document.addEventListener("visibilitychange", this._onVisibilityBound);
            this.playlist.start(url, this._currentMode);
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_startTimeUpdate).call(this);
        }
        async stop() {
            const wasRunning = this.running;
            this.running = false;
            this._paused = true;
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_stopTimeUpdate).call(this);
            this.playlist.stop();
            document.removeEventListener("visibilitychange", this._onVisibilityBound);
            if (this.renderRafId) {
                cancelAnimationFrame(this.renderRafId);
                this.renderRafId = 0;
            }
            this.videoQueue.length = 0;
            this.videoClockOffsetSec = null;
            this.droppedVideoFrames = 0;
            this.lastDropLogAt = 0;
            this.lastVideoRawPtsMs = null;
            this.lastVideoNormPtsMs = null;
            this.videoFrameDurMs = 33.33;
            this.lastAudioRawPtsMs = null;
            this.lastAudioNormPtsMs = null;
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushPendingSegmentInfos).call(this);
            this.segmentInfoQueue.length = 0;
            this._lastRenderedFramePtsSec = null;
            this.wasm.reset();
            this.audio.reset();
            if (this.audioDecoder)
                this.audioDecoder.clear();
            this._hasSeparateAudioTrack = false;
            this._avGateOpen = true;
            this._pendingAudioFrames.length = 0;
            if (this._avGateTimer) {
                clearTimeout(this._avGateTimer);
                this._avGateTimer = 0;
            }
            if (wasRunning) {
                this._emit("abort", {});
            }
            this.log("Playback stopped.");
        }
        async destroy() {
            await this.stop();
            if (this.renderer && typeof this.renderer.destroy === "function") {
                this.renderer.destroy();
            }
            if (this.audio && typeof this.audio.destroy === "function") {
                this.audio.destroy();
            }
            this.wasm.destroy();
            this._initialized = false;
            this._initPromise = null;
        }
        /** Seek to a target time (seconds). */
        async seek(timeSec) {
            if (!this.running || !this.playlist.isLoaded) {
                this.log("Cannot seek: not playing.");
                return;
            }
            this.log(`Seeking to ${timeSec.toFixed(1)}s`);
            this._ended = false;
            this._emit("seeking", { target: timeSec });
            // Reset decoder state
            this.wasm.reset();
            this.audio.reset();
            if (this.audioDecoder)
                this.audioDecoder.reset();
            // Re-arm the A/V startup gate so post-seek audio waits for the first
            // decoded video frame again (prevents audio racing ahead after a seek).
            this._avGateOpen = false;
            this._pendingAudioFrames.length = 0;
            if (this._avGateTimer) {
                clearTimeout(this._avGateTimer);
                this._avGateTimer = 0;
            }
            this._avGateTimer = window.setTimeout(() => __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_openAvGate).call(this), 2000);
            this.videoQueue.length = 0;
            this.videoClockOffsetSec = null;
            this.lastVideoRawPtsMs = null;
            this.lastVideoNormPtsMs = null;
            this.lastAudioRawPtsMs = null;
            this.lastAudioNormPtsMs = null;
            this.droppedVideoFrames = 0;
            this.lastDropLogAt = 0;
            this._lastRenderedFramePtsSec = null;
            const segmentStart = await this.playlist.seek(timeSec);
            this._seekBaseTime = segmentStart;
            this._playingFired = false; // re-fire playing once first frame after seek renders
            this.log(`Seek done, segment starts at ${segmentStart.toFixed(1)}s`);
            this._emit("seeked", { currentTime: this.currentTime });
        }
        /* ============================================================== */
        /* HTMLMediaElement-style methods                                  */
        /* ============================================================== */
        /** Resume playback. If never started, this is a no-op (use `start()` first). */
        async play() {
            if (!this.playlist.isLoaded) {
                // Mirror HTMLMediaElement: play() on an unloaded element is a no-op
                // (we don't auto-load because we don't know what URL to use).
                this.log("play() ignored: no media loaded. Call start(url, mode) first.");
                return;
            }
            if (!this._paused)
                return;
            this._paused = false;
            this.running = true;
            this._playingFired = false;
            if (!this.renderRafId) {
                __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_startRenderLoop).call(this);
            }
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_startTimeUpdate).call(this);
            await this.audio.resume();
        }
        /** Pause playback (audio + render loop), keep buffers and HLS state. */
        async pause() {
            if (this._paused)
                return;
            this._paused = true;
            this.running = false;
            if (this.renderRafId) {
                cancelAnimationFrame(this.renderRafId);
                this.renderRafId = 0;
            }
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_stopTimeUpdate).call(this);
            await this.audio.suspend();
        }
        /** Reload the current source. Equivalent to stop() + start(currentSrc). */
        async load() {
            if (!this._currentSrc) {
                this.log("load() ignored: no current source.");
                return;
            }
            const url = this._currentSrc;
            const mode = this._currentMode;
            await this.start(url, mode);
        }
        /* ============================================================== */
        /* Backward-compatible helpers                                     */
        /* ============================================================== */
        getCurrentTime() {
            return this.currentTime;
        }
        getTotalDuration() {
            return this._totalDuration || 0;
        }
        /**
         * Route a decoded audio PCM frame to the renderer, honoring the A/V startup
         * gate. While the gate is closed (master mode, before the first video frame),
         * frames are buffered so the audio clock does not start before video.
         */
        _emitAudioFrame(frame) {
            if (!this._avGateOpen) {
                this._pendingAudioFrames.push(frame);
                // Safety cap: don't buffer unbounded audio if video never shows up
                // before the timeout (the timer will open the gate anyway).
                if (this._pendingAudioFrames.length > 400) {
                    this._pendingAudioFrames.shift();
                }
                return;
            }
            this.audio.enqueueFrame(frame);
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_logSegmentAudioInfo).call(this, frame.channels, frame.sampleRate, frame.sampleCount, frame.ptsMs, "aac(native)");
        }
        async _waitForFlowControl() {
            while (this.running) {
                const audioBuffered = this.audio.getBufferedSeconds();
                const videoLeadSec = __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_getVideoLeadSec).call(this);
                const queueOk = this.videoQueue.length <= this.videoQueueHighWatermark;
                if (audioBuffered <= this.maxAudioBufferedSec && videoLeadSec <= this.maxVideoLeadSec && queueOk) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        /**
         * Audio-only back-pressure for the standalone audio track. Independent from
         * the video gate so slow video decoding cannot starve audio (and vice
         * versa). Only throttles when the scheduled audio buffer runs ahead.
         */
        async _waitForAudioFlowControl() {
            while (this.running) {
                if (this.audio.getBufferedSeconds() <= this.maxAudioBufferedSec) {
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, 20));
            }
        }
        _beginSegmentInfo(segmentUrl, byteLength) {
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushHeadSegmentInfo).call(this);
            this.segmentInfoQueue.push({
                id: ++this.segmentSeq,
                segmentUrl,
                byteLength,
                videoInfo: null,
                audioInfo: null,
                printed: false,
                createdAt: Date.now(),
            });
            // Evict entries that exceed the age limit (e.g. single-track streams
            // where one info type never arrives, preventing automatic flush).
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_evictStaleSegmentInfos).call(this);
            while (this.segmentInfoQueue.length > this.maxPendingSegmentInfo) {
                const stale = this.segmentInfoQueue.shift();
                if (stale)
                    __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushSegmentInfo).call(this, stale, true);
            }
        }
    }
    _HlsWasmPlayer_instances = new WeakSet(), _HlsWasmPlayer_maybeFallbackFromLowLatency = function _HlsWasmPlayer_maybeFallbackFromLowLatency(msg) {
        if (!this.playlist.isLoaded || !this.playlist.isLowLatencyMode || this.hevcCompatFallbackTriggered) {
            return;
        }
        const text = String(msg || "").toLowerCase();
        const hevcHeaderParseFailed = text.includes("failed to parse header of nalu");
        const hevcInvalidData = text.includes("hevc") && text.includes("invalid data found");
        if (!hevcHeaderParseFailed && !hevcInvalidData) {
            return;
        }
        this.hevcCompatFallbackTriggered = true;
        this.playlist.setLowLatencyMode(false);
        this.log("[compat] HEVC NALU parse warning detected. Switched to segment-only mode.");
    }, _HlsWasmPlayer_enqueueVideoFrame = function _HlsWasmPlayer_enqueueVideoFrame(frame) {
        if (!Number.isFinite(frame.ptsMs)) {
            return;
        }
        this.videoQueue.push(frame);
    }, _HlsWasmPlayer_startRenderLoop = function _HlsWasmPlayer_startRenderLoop() {
        if (this.renderRafId) {
            cancelAnimationFrame(this.renderRafId);
        }
        // For video-only streams (no audio clock) we pace by decoded-frame arrival
        // rather than by wall-clock, so slow software decoding (large HEVC frames,
        // 4K, etc.) doesn't make every-frame "late" and cause a frozen picture.
        let lastRenderWallSec = 0;
        const tick = () => {
            if (!this.running) {
                this.renderRafId = 0;
                return;
            }
            const audioMediaTimeSec = this.audio.getMediaTimeSec();
            const nowSec = performance.now() / 1000;
            if (audioMediaTimeSec !== null) {
                // ---- A/V sync path: drive video by the audio clock ----
                let renderedThisTick = 0;
                let droppedThisTick = 0;
                while (this.videoQueue.length > 0) {
                    const head = this.videoQueue[0];
                    const headPtsSec = head.ptsMs / 1000;
                    const delta = headPtsSec - audioMediaTimeSec;
                    if (delta > 0.01) {
                        break;
                    }
                    this.videoQueue.shift();
                    if (delta < -this.dropLateFrameSec) {
                        if (droppedThisTick >= this.maxFrameDropsPerTick) {
                            break;
                        }
                        this.droppedVideoFrames += 1;
                        droppedThisTick += 1;
                        continue;
                    }
                    this.renderer.renderYuv420(head);
                    this._lastRenderedFramePtsSec = headPtsSec;
                    lastRenderWallSec = nowSec;
                    __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_maybeMarkEnded).call(this);
                    renderedThisTick += 1;
                    if (renderedThisTick >= 2) {
                        break;
                    }
                }
            }
            else if (this.videoQueue.length > 0) {
                // ---- Video-only path: pace by frame-duration, never drop "late" ----
                // Pull at most one frame per RAF tick, but only after the previous
                // frame has been on screen for at least its PTS-derived duration.
                const minIntervalSec = Math.max(5, this.videoFrameDurMs || 33.33) / 1000;
                if (nowSec - lastRenderWallSec >= minIntervalSec * 0.9) {
                    const head = this.videoQueue.shift();
                    if (!head)
                        return;
                    const headPtsSec = head.ptsMs / 1000;
                    this.renderer.renderYuv420(head);
                    this._lastRenderedFramePtsSec = headPtsSec;
                    lastRenderWallSec = nowSec;
                    __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_maybeMarkEnded).call(this);
                }
            }
            this.renderRafId = requestAnimationFrame(tick);
        };
        this.renderRafId = requestAnimationFrame(tick);
    }, _HlsWasmPlayer_maybeMarkEnded = function _HlsWasmPlayer_maybeMarkEnded() {
        if (this._currentMode !== "vod")
            return;
        if (this._ended)
            return;
        if (!this._totalDuration)
            return;
        if (this.currentTime >= this._totalDuration - 0.05 && this.videoQueue.length === 0) {
            this._ended = true;
            this._paused = true;
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_stopTimeUpdate).call(this);
            this._emit("ended", { currentTime: this.currentTime });
        }
    }, _HlsWasmPlayer_startTimeUpdate = function _HlsWasmPlayer_startTimeUpdate() {
        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_stopTimeUpdate).call(this);
        this._timeUpdateTimerId = window.setInterval(() => {
            const t = this.currentTime;
            // emit timeupdate when time has actually moved (or first emission)
            if (t !== this._lastEmittedTimeSec) {
                this._lastEmittedTimeSec = t;
                this._emit("timeupdate", { currentTime: t });
            }
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_updatePlayingWaitingState).call(this);
        }, 250);
    }, _HlsWasmPlayer_stopTimeUpdate = function _HlsWasmPlayer_stopTimeUpdate() {
        if (this._timeUpdateTimerId) {
            clearInterval(this._timeUpdateTimerId);
            this._timeUpdateTimerId = 0;
        }
    }, _HlsWasmPlayer_updatePlayingWaitingState = function _HlsWasmPlayer_updatePlayingWaitingState() {
        if (this._paused || this._ended)
            return;
        const hasFrame = this._lastRenderedFramePtsSec !== null;
        const audioBuffered = this.audio.getBufferedSeconds();
        const videoLead = __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_getVideoLeadSec).call(this);
        const starving = hasFrame && audioBuffered <= 0.05 && videoLead <= 0.05 && this.videoQueue.length === 0;
        if (hasFrame && !starving && !this._playingFired) {
            this._playingFired = true;
            this._waitingFired = false;
            this._emit("playing", { currentTime: this.currentTime });
        }
        else if (starving && !this._waitingFired) {
            this._waitingFired = true;
            this._playingFired = false;
            this._emit("waiting", { currentTime: this.currentTime });
        }
    }, _HlsWasmPlayer_onVisibilityChange = function _HlsWasmPlayer_onVisibilityChange() {
        if (document.visibilityState !== "visible")
            return;
        if (!this.running || this.videoQueue.length === 0)
            return;
        const mediaTimeSec = this.audio.getMediaTimeSec();
        const headPtsSec = this.videoQueue[0].ptsMs / 1000;
        // If the audio clock has advanced far beyond the oldest queued video
        // frame (e.g. several seconds), the queue is irrecoverably stale.
        // Flush everything behind mediaTime and reset the offset so the
        // render loop doesn't spend ticks doing nothing but dropping frames.
        if (mediaTimeSec !== null && mediaTimeSec - headPtsSec > 1.0) {
            // Drop all frames whose PTS is behind mediaTime.
            while (this.videoQueue.length > 0) {
                const pts = this.videoQueue[0].ptsMs / 1000;
                if (pts >= mediaTimeSec - this.dropLateFrameSec)
                    break;
                this.videoQueue.shift();
                this.droppedVideoFrames += 1;
            }
            this.videoClockOffsetSec = null;
            this.log(`[visibility] flushed stale video frames (${this.videoQueue.length} remaining)`);
        }
    }, _HlsWasmPlayer_openAvGate = function _HlsWasmPlayer_openAvGate() {
        if (this._avGateOpen)
            return;
        this._avGateOpen = true;
        if (this._avGateTimer) {
            clearTimeout(this._avGateTimer);
            this._avGateTimer = 0;
        }
        if (this._pendingAudioFrames.length > 0) {
            const frames = this._pendingAudioFrames;
            this._pendingAudioFrames = [];
            for (const frame of frames) {
                this.audio.enqueueFrame(frame);
                __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_logSegmentAudioInfo).call(this, frame.channels, frame.sampleRate, frame.sampleCount, frame.ptsMs, "aac(native)");
            }
        }
    }, _HlsWasmPlayer_getVideoLeadSec = function _HlsWasmPlayer_getVideoLeadSec() {
        if (this.videoQueue.length === 0) {
            return 0;
        }
        const mediaTimeSec = this.audio.getMediaTimeSec();
        if (mediaTimeSec === null) {
            return this.videoQueue.length / 30;
        }
        const tailPtsSec = this.videoQueue[this.videoQueue.length - 1].ptsMs / 1000;
        return Math.max(0, tailPtsSec - mediaTimeSec);
    }, _HlsWasmPlayer_normalizeVideoPts = function _HlsWasmPlayer_normalizeVideoPts(rawPtsMs) {
        const hasRaw = Number.isFinite(rawPtsMs);
        if (this.lastVideoNormPtsMs === null) {
            this.lastVideoRawPtsMs = hasRaw ? rawPtsMs : 0;
            this.lastVideoNormPtsMs = 0;
            return 0;
        }
        let stepMs = this.videoFrameDurMs;
        if (hasRaw && this.lastVideoRawPtsMs !== null) {
            const deltaMs = rawPtsMs - this.lastVideoRawPtsMs;
            if (deltaMs > 2 && deltaMs < 120) {
                stepMs = deltaMs;
                this.videoFrameDurMs = this.videoFrameDurMs * 0.9 + deltaMs * 0.1;
            }
        }
        if (hasRaw) {
            this.lastVideoRawPtsMs = rawPtsMs;
        }
        this.lastVideoNormPtsMs += Math.max(5, stepMs);
        return this.lastVideoNormPtsMs;
    }, _HlsWasmPlayer_normalizeAudioPts = function _HlsWasmPlayer_normalizeAudioPts(rawPtsMs, sampleCount, sampleRate) {
        const frameDurMs = sampleRate > 0 ? (sampleCount * 1000) / sampleRate : 20;
        const hasRaw = Number.isFinite(rawPtsMs);
        if (this.lastAudioNormPtsMs === null) {
            this.lastAudioRawPtsMs = hasRaw ? rawPtsMs : 0;
            this.lastAudioNormPtsMs = 0;
            return 0;
        }
        let stepMs = frameDurMs;
        if (hasRaw && this.lastAudioRawPtsMs !== null) {
            const deltaMs = rawPtsMs - this.lastAudioRawPtsMs;
            if (deltaMs > 2 && deltaMs < 250) {
                stepMs = deltaMs;
            }
        }
        if (hasRaw) {
            this.lastAudioRawPtsMs = rawPtsMs;
        }
        this.lastAudioNormPtsMs += Math.max(5, stepMs);
        return this.lastAudioNormPtsMs;
    }, _HlsWasmPlayer_logSegmentVideoInfo = function _HlsWasmPlayer_logSegmentVideoInfo(width, height, yStride, uStride, vStride, ptsMs, fps, codecName) {
        const ctx = this.segmentInfoQueue.find((item) => !item.videoInfo);
        if (!ctx) {
            return;
        }
        ctx.videoInfo = {
            width,
            height,
            yStride,
            uStride,
            vStride,
            ptsMs,
            fps,
            codecName: codecName || "unknown",
        };
        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushSegmentInfo).call(this, ctx, false);
    }, _HlsWasmPlayer_logSegmentAudioInfo = function _HlsWasmPlayer_logSegmentAudioInfo(channels, sampleRate, sampleCount, ptsMs, codecName) {
        const ctx = this.segmentInfoQueue.find((item) => !item.audioInfo);
        if (!ctx) {
            return;
        }
        ctx.audioInfo = {
            channels,
            sampleRate,
            sampleCount,
            ptsMs,
            codecName: codecName || "unknown",
        };
        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushSegmentInfo).call(this, ctx, false);
    }, _HlsWasmPlayer_flushSegmentInfo = function _HlsWasmPlayer_flushSegmentInfo(ctx, force = false) {
        if (!ctx || ctx.printed) {
            return;
        }
        if (!force && (!ctx.videoInfo || !ctx.audioInfo)) {
            return;
        }
        const videoText = ctx.videoInfo
            ? `videoInfo(codec=${ctx.videoInfo.codecName} width=${ctx.videoInfo.width} height=${ctx.videoInfo.height} y=${ctx.videoInfo.yStride} u=${ctx.videoInfo.uStride} v=${ctx.videoInfo.vStride} pts=${ctx.videoInfo.ptsMs.toFixed(2)}ms fps=${ctx.videoInfo.fps.toFixed(3)})`
            : "videoInfo(n/a)";
        const audioText = ctx.audioInfo
            ? `audioInfo(codec=${ctx.audioInfo.codecName} channels=${ctx.audioInfo.channels} sampleRate=${ctx.audioInfo.sampleRate} samples=${ctx.audioInfo.sampleCount} pts=${ctx.audioInfo.ptsMs.toFixed(2)}ms)`
            : "audioInfo(n/a)";
        this.log(`[seg-info] #${ctx.id} ${__classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_shortSegmentName).call(this, ctx.segmentUrl)} size=${ctx.byteLength}B ${videoText} ${audioText}`);
        ctx.printed = true;
        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_compactSegmentInfoQueue).call(this);
    }, _HlsWasmPlayer_flushHeadSegmentInfo = function _HlsWasmPlayer_flushHeadSegmentInfo() {
        if (this.segmentInfoQueue.length === 0) {
            return;
        }
        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushSegmentInfo).call(this, this.segmentInfoQueue[0], true);
    }, _HlsWasmPlayer_flushPendingSegmentInfos = function _HlsWasmPlayer_flushPendingSegmentInfos() {
        for (const item of this.segmentInfoQueue) {
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushSegmentInfo).call(this, item, true);
        }
    }, _HlsWasmPlayer_compactSegmentInfoQueue = function _HlsWasmPlayer_compactSegmentInfoQueue() {
        // Evict entries that are both printed AND aged out.
        __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_evictStaleSegmentInfos).call(this);
        while (this.segmentInfoQueue.length > 0) {
            const head = this.segmentInfoQueue[0];
            if (!head.printed) {
                break;
            }
            this.segmentInfoQueue.shift();
        }
    }, _HlsWasmPlayer_evictStaleSegmentInfos = function _HlsWasmPlayer_evictStaleSegmentInfos() {
        const now = Date.now();
        while (this.segmentInfoQueue.length > 0) {
            const head = this.segmentInfoQueue[0];
            if (!head.createdAt || now - head.createdAt < this.maxSegmentInfoAgeMs) {
                break;
            }
            __classPrivateFieldGet(this, _HlsWasmPlayer_instances, "m", _HlsWasmPlayer_flushSegmentInfo).call(this, head, true);
            this.segmentInfoQueue.shift();
        }
    }, _HlsWasmPlayer_shortSegmentName = function _HlsWasmPlayer_shortSegmentName(segmentUrl) {
        try {
            const url = new URL(segmentUrl);
            const parts = url.pathname.split("/");
            return parts[parts.length - 1] || segmentUrl;
        }
        catch {
            return segmentUrl;
        }
    };

    exports.HlsWasmPlayer = HlsWasmPlayer;

}));
//# sourceMappingURL=index.umd.js.map
