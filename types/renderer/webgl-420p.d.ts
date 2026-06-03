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
export declare class WebGlRender {
    #private;
    static VERTEX_SHADER_SOURCE: string;
    static FRAGMENT_SHADER_SOURCE: string;
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
    constructor(canvas: HTMLCanvasElement, options?: WebGLContextAttributes);
    /**
     * Render a YUV420P frame coming from the WASM decoder.
     *
     * @param {IYUV420PFrame} frame
     */
    renderYuv420(frame: IYUV420PFrame): void;
    destroy(): void;
}
export default WebGlRender;
