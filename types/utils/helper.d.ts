declare class Helper {
    /**
     * Per-track fetch loop state. Each track ("muxed" | "video" | "audio")
     * carries its own seen-set, init-loaded flag and abort controller.
     */
    static makeTrackState(kind: "muxed" | "video" | "audio", url: string): {
        kind: "muxed" | "video" | "audio";
        url: string;
        seen: Set<string>;
        initLoaded: boolean;
        sleepResolve: (() => void) | null;
        running: boolean;
    };
    /**
     * Merge two HeadersInit-ish values into a plain object.
     */
    static flattenHeaders(h?: HeadersInit): Record<string, string>;
    static getPlaylistType(text: string): "live" | "vod";
}
export default Helper;
