import { HlsController } from "../hls/hls_controller";
import type { HlsWasmPlayer } from "../player";
export declare class PlaylistManager {
    private player;
    hls: HlsController | null;
    private _totalDuration;
    constructor(player: HlsWasmPlayer);
    get duration(): number;
    start(url: string): void;
    stop(): void;
    seek(timeSec: number): Promise<number>;
    get isLowLatencyMode(): boolean;
    setLowLatencyMode(value: boolean): void;
    get isLoaded(): boolean;
}
