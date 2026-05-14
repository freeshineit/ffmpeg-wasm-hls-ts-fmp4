export class WebGLRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.gl = canvas.getContext("webgl", { antialias: false, alpha: false });
    if (!this.gl) {
      throw new Error("WebGL not supported in this browser.");
    }

    this.program = this.#createProgram();
    this.textures = this.#createTextures();
    this.#createGeometry();
  }

  renderYuv420(frame) {
    const { width, height, y, u, v, yStride, uStride, vStride } = frame;
    this.#uploadPlane(this.textures[0], width, height, y, yStride);
    this.#uploadPlane(this.textures[1], width >> 1, height >> 1, u, uStride);
    this.#uploadPlane(this.textures[2], width >> 1, height >> 1, v, vStride);

    this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    this.gl.drawArrays(this.gl.TRIANGLE_STRIP, 0, 4);
  }

  #createProgram() {
    const gl = this.gl;
    const vs = gl.createShader(gl.VERTEX_SHADER);
    const fs = gl.createShader(gl.FRAGMENT_SHADER);

    gl.shaderSource(
      vs,
      `
      attribute vec2 a_pos;
      varying vec2 v_uv;
      void main() {
        gl_Position = vec4(a_pos, 0.0, 1.0);
        v_uv = (a_pos + 1.0) * 0.5;
        v_uv.y = 1.0 - v_uv.y;
      }
      `,
    );

    gl.shaderSource(
      fs,
      `
      precision mediump float;
      varying vec2 v_uv;
      uniform sampler2D texY;
      uniform sampler2D texU;
      uniform sampler2D texV;

      void main() {
        float y = texture2D(texY, v_uv).r;
        float u = texture2D(texU, v_uv).r - 0.5;
        float v = texture2D(texV, v_uv).r - 0.5;

        float r = y + 1.402 * v;
        float g = y - 0.344136 * u - 0.714136 * v;
        float b = y + 1.772 * u;

        gl_FragColor = vec4(r, g, b, 1.0);
      }
      `,
    );

    gl.compileShader(vs);
    gl.compileShader(fs);

    if (!gl.getShaderParameter(vs, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(vs) || "Vertex shader compile failed");
    }
    if (!gl.getShaderParameter(fs, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(fs) || "Fragment shader compile failed");
    }

    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);

    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(program) || "Program link failed");
    }

    gl.useProgram(program);
    gl.uniform1i(gl.getUniformLocation(program, "texY"), 0);
    gl.uniform1i(gl.getUniformLocation(program, "texU"), 1);
    gl.uniform1i(gl.getUniformLocation(program, "texV"), 2);

    return program;
  }

  #createTextures() {
    const gl = this.gl;
    const textures = [gl.createTexture(), gl.createTexture(), gl.createTexture()];

    for (let i = 0; i < textures.length; i += 1) {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, textures[i]);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    return textures;
  }

  #createGeometry() {
    const gl = this.gl;
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    const aPos = gl.getAttribLocation(this.program, "a_pos");
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);
  }

  #uploadPlane(texture, width, height, data, stride) {
    const gl = this.gl;
    const plane = new Uint8Array(width * height);

    for (let row = 0; row < height; row += 1) {
      plane.set(data.subarray(row * stride, row * stride + width), row * width);
    }

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, width, height, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, plane);
  }
}
