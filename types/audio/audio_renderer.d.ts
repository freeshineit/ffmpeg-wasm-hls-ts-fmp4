export declare class AudioRenderer {
    audioContext: AudioContext | null;
    gainNode: GainNode | null;
    startedAt: number;
    nextPlayTime: number;
    mediaOffsetSec: number | null;
    _volume: number;
    _muted: boolean;
    _playbackRate: number;
    _activeSources: Array<AudioBufferSourceNode & {
        _startAt?: number;
        _endsAt?: number;
    }>;
    _keepAliveOsc: OscillatorNode | null;
    _keepAliveGain: GainNode | null;
    _unlockBound: (() => void) | null;
    constructor();
    init(): Promise<void>;
    _tryResume(): Promise<void>;
    /** Silent oscillator → gain=0 → destination. Keeps AudioContext running. */
    _startKeepAlive(): void;
    setVolume(v: number): void;
    setMuted(m: boolean): void;
    setPlaybackRate(rate: number): void;
    suspend(): Promise<void>;
    resume(): Promise<void>;
    enqueueFrame(frame: {
        channels: number;
        sampleRate: number;
        sampleCount: number;
        pcm: Float32Array;
        ptsMs: number;
    }): void;
    getBufferedSeconds(): number;
    getMediaTimeSec(): number | null;
    reset(): void;
    destroy(): void;
}
