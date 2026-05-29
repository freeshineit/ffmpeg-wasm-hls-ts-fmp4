import { HlsController } from "../hls/hls_controller";
import type { HlsWasmPlayer } from "../player";

export class PlaylistManager {
  private player: HlsWasmPlayer;
  public hls: HlsController | null = null;
  private _totalDuration: number = 0;

  constructor(player: HlsWasmPlayer) {
    this.player = player;
  }

  public get duration(): number {
    if (this.player._currentMode === "live" && !this._totalDuration) {
      return Infinity;
    }
    return this._totalDuration || 0;
  }

  public start(url: string, mode: "live" | "vod") {
    this._totalDuration = 0;
    this.hls = new HlsController({
      mode: mode,
      lowLatencyMode: true,
      onDuration: (dur: number) => {
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
      onError: (err: unknown) => {
        this.player._emit("error", {
          message: err instanceof Error ? err.message : String(err),
          error: err,
        });
      },
      onSegment: async (bytes: Uint8Array, isInitSegment: boolean, segmentUrl: string, trackKind: "video" | "audio" | "muxed") => {
        if (trackKind === "audio") {
          await this.player._waitForAudioFlowControl();
          this.player._hasSeparateAudioTrack = true;
          if (!this.player.audioDecoder) return;
          if (isInitSegment) {
            this.player.audioDecoder.setInitSegment(bytes);
            this.player.log(`audio-init: ${segmentUrl}`);
          } else {
            void this.player.audioDecoder.feedSegment(bytes);
            this.player.log(`audio-seg: ${segmentUrl}`);
          }
          return;
        }

        await this.player._waitForFlowControl();
        if (!isInitSegment) {
          this.player._beginSegmentInfo(segmentUrl, bytes.length);
        }
        this.player.wasm.feedSegment(bytes, isInitSegment);
        this.player.log(`${isInitSegment ? "init" : "seg"}: ${segmentUrl}`);
      },
    });

    this.player.log(`Start ${mode} playback: ${url}`);
    this.hls.start(url);
  }

  public stop() {
    if (this.hls) {
      this.hls.stop();
      this.hls = null;
    }
  }

  public async seekTo(timeSec: number) {
    if (this.hls) {
      return await this.hls.seekTo(timeSec);
    }
    return 0;
  }

  public get isLowLatencyMode(): boolean {
    return this.hls ? this.hls.lowLatencyMode : false;
  }

  public setLowLatencyMode(value: boolean) {
    if (!this.hls) return;
    if (typeof this.hls.setLowLatencyMode === "function") {
      this.hls.setLowLatencyMode(value);
    } else {
      this.hls.lowLatencyMode = value;
    }
  }

  public get isLoaded(): boolean {
    return this.hls !== null;
  }
}
