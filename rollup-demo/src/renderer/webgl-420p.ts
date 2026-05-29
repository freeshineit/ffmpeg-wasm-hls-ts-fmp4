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

import Texture from "./Texture";

export interface IYUV420PFrame {
  width: number;
  height: number;
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
  yStride: number;
  uStride: number;
  vStride: number;
}

export class WebGlRender {
  static VERTEX_SHADER_SOURCE = [
    "attribute highp vec4 aVertexPosition;",
    "attribute vec2 aTextureCoord;",
    "varying highp vec2 vTextureCoord;",
    "void main(void) {",
    "  gl_Position = aVertexPosition;",
    "  vTextureCoord = aTextureCoord;",
    "}",
  ].join("\n");

  static FRAGMENT_SHADER_SOURCE = [
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

  gl: WebGLRenderingContext;
  canvas: HTMLCanvasElement;
  program: WebGLProgram;
  verticesBuffer: WebGLBuffer | null;
  texCoordBuffer: WebGLBuffer | null;
  yTexture: Texture;
  uTexture: Texture;
  vTexture: Texture;
  _yScratch: Uint8Array | null;
  _uScratch: Uint8Array | null;
  _vScratch: Uint8Array | null;

  constructor(canvas: HTMLCanvasElement, options: WebGLContextAttributes = {}) {
    const contextAttributes = Object.assign(
      {
        antialias: false,
        alpha: false,
        preserveDrawingBuffer: false,
      },
      options,
    );

    const gl = (canvas.getContext("webgl", contextAttributes) as WebGLRenderingContext | null) || (canvas.getContext("experimental-webgl", contextAttributes) as WebGLRenderingContext | null);
    if (!gl) {
      throw new Error("WebGL not supported in this browser.");
    }
    this.gl = gl;
    this.canvas = canvas;

    this.#addEventListeners();

    this.program = this.#createProgram();

    this.verticesBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.verticesBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([1.0, 1.0, 0.0, -1.0, 1.0, 0.0, 1.0, -1.0, 0.0, -1.0, -1.0, 0.0]), gl.STATIC_DRAW);
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
  renderYuv420(frame: IYUV420PFrame): void {
    const { width, height, y, u, v, yStride, uStride, vStride } = frame;
    const cw = width >> 1;
    const ch = height >> 1;

    const yPacked = this.#packPlane(y, width, height, yStride, "_yScratch");
    const uPacked = this.#packPlane(u, cw, ch, uStride, "_uScratch");
    const vPacked = this.#packPlane(v, cw, ch, vStride, "_vScratch");

    const gl = this.gl;
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0.0, 0.0, 0.0, 0.0);
    gl.clear(gl.COLOR_BUFFER_BIT);

    this.yTexture.fill(width, height, yPacked);
    this.uTexture.fill(cw, ch, uPacked);
    this.vTexture.fill(cw, ch, vPacked);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  destroy(): void {
    try {
      const gl = this.gl;
      gl.deleteProgram(this.program);
      gl.deleteBuffer(this.verticesBuffer);
      gl.deleteBuffer(this.texCoordBuffer);
      gl.deleteTexture(this.yTexture.texture);
      gl.deleteTexture(this.uTexture.texture);
      gl.deleteTexture(this.vTexture.texture);

      this.#removeEventListener();

      this.verticesBuffer = null;
      this.texCoordBuffer = null;
      this._yScratch = null;
      this._uScratch = null;
      this._vScratch = null;
    } catch (err) {
      console.log("webgl destroyContext fail", err);
    }
  }

  #createProgram(): WebGLProgram {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    if (!vs) {
      throw new Error("Failed to create vertex shader");
    }
    gl.shaderSource(vs, WebGlRender.VERTEX_SHADER_SOURCE);
    gl.compileShader(vs);
    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(vs) || "Vertex shader compile failed");
    }

    const fs = gl.createShader(gl.FRAGMENT_SHADER);
    if (!fs) {
      throw new Error("Failed to create fragment shader");
    }
    gl.shaderSource(fs, WebGlRender.FRAGMENT_SHADER_SOURCE);
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
  }

  /**
   * Pack a (possibly strided) plane into a tight `width * height` buffer.
   * Reuses a per-plane scratch buffer to avoid per-frame allocations.
   */
  #packPlane(data: Uint8Array, width: number, height: number, stride: number, scratchKey: "_yScratch" | "_uScratch" | "_vScratch"): Uint8Array {
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
  }

  // ---------------------------------------------------------------------------------------
  // canvas event Listeners
  // ---------------------------------------------------------------------------------------

  #webglcontextlostFun(e: Event): void {
    e.preventDefault(); // 阻止浏览器默认处理
    console.log("WebGL 上下文丢失，等待恢复");
  }

  #webglcontextrestoredFun(_e: Event): void {
    console.log("WebGL 上下文恢复，重新初始化资源");
    // 重新创建着色器、纹理、缓冲区等
    // initWebGLResources();
  }

  #addEventListeners() {
    this.canvas.addEventListener("webglcontextlost", this.#webglcontextlostFun);
    this.canvas.addEventListener("webglcontextrestored", this.#webglcontextrestoredFun);
  }

  #removeEventListener() {
    this.canvas.removeEventListener("webglcontextlost", this.#webglcontextlostFun);
    this.canvas.removeEventListener("webglcontextrestored", this.#webglcontextrestoredFun);
  }
}

export default WebGlRender;
