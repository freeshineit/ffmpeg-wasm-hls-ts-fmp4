import type { WasmBridgeOptions, WasmInitCallbacks } from "../types";
export declare class WasmBridge {
    wasmJsUrl: string;
    wasmFileUrl: string;
    worker: Worker | null;
    initPromiseResolver: (() => void) | null;
    initPromiseRejecter: ((error: Error) => void) | null;
    _currentTime: number;
    constructor({ wasmJsUrl, wasmFileUrl }: WasmBridgeOptions);
    init({ onVideoFrame, onAudioFrame, onLog }: WasmInitCallbacks): Promise<void>;
    feedSegment(bytes: Uint8Array, isInitSegment: boolean): void;
    reset(): void;
    getCurrentTime(): number;
    destroy(): void;
}
