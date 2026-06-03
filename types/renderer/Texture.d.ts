declare class Texture {
    gl: WebGLRenderingContext;
    texture: WebGLTexture | null;
    constructor(gl: WebGLRenderingContext);
    bind(unit: number, program: WebGLProgram, samplerName: string): void;
    fill(width: number, height: number, data: Uint8Array): void;
}
export default Texture;
