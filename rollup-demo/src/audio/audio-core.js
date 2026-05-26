/**
 * AudioCore — PCM-input audio renderer ported from the encoded-bytes
 * `audio-core.ts` reference.
 *
 * Differences from the TS reference:
 *  - Input is already-decoded PCM frames (Float32, interleaved):
 *      { channels, sampleRate, sampleCount, pcm: Float32Array, ptsMs }
 *    Therefore there is no `decodeAudioData` step; merged PCM buffers are
 *    written directly into an AudioBuffer.
 *  - Removed external deps (`@ezuikit/utils-logger`, `../constant`,
 *    `../utils/tools`).
 *  - Scheduling uses the AudioContext clock (`source.start(when)`) instead of
 *    `onended`-driven ping-pong, which avoids JS-event-loop gaps for short
 *    PCM frames. The audio-core conceptual model (sampleQueue, nextBuffer,
 *    gain node, play/pause/stop, getAlignVPTS) is preserved.
 */

const DEFAULT_CONSUME_SAMPLE_LEN = 4; // merge ~4 PCM frames per playback chunk

const AudioCtor = window.AudioContext || window.webkitAudioContext;

export class AudioCore {
  constructor(options = {}) {
    this.options = {
      isLive: options.isLive !== false,
      volume: typeof options.volume === "number" ? options.volume : 1.0,
      consumeSampleLen: options.consumeSampleLen || DEFAULT_CONSUME_SAMPLE_LEN,
    };

    this.audioCtx = null;
    this.gainNode = null;

    this.sampleQueue = [];
    this.nextBuffer = null; // { buffer: AudioBuffer, ptsMs }
    this.scheduledSources = [];
    this.maxScheduledSources = 32;

    this.startStatus = false;

    // media clock (preferred) — based on AudioContext.currentTime
    this.mediaOffsetSec = null;
    this.nextPlayTime = 0;

    // audio-core compat clock — playTimestamp + (now - playStartedAt)
    this.playTimestamp = 0;
    this.playStartedAt = 0;

    this.schedulerTimer = 0;
    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._unlockBound = null;
  }

  /* ------------------------------------------------------------------ */
  /* Lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  async init() {
    if (this.audioCtx) {
      return this._tryResume();
    }

    this.audioCtx = new AudioCtor({ latencyHint: "interactive" });
    this.gainNode = this.audioCtx.createGain();
    this.gainNode.gain.value = this.options.volume;
    this.gainNode.connect(this.audioCtx.destination);
    this.nextPlayTime = this.audioCtx.currentTime;

    this._startKeepAlive();

    this.audioCtx.addEventListener("statechange", () => {
      if (this.audioCtx && this.audioCtx.state === "suspended") {
        this.audioCtx.resume().catch(() => {});
      }
    });

    this._unlockBound = () => this._tryResume();
    document.addEventListener("pointerdown", this._unlockBound, { once: true });
    document.addEventListener("touchend", this._unlockBound, { once: true });

    this.startStatus = true;
    this._startScheduler();
    return this._tryResume();
  }

  async _tryResume() {
    if (!this.audioCtx) return;
    if (this.audioCtx.state !== "running") {
      try {
        await this.audioCtx.resume();
      } catch (_) {
        // iOS rejects without a user gesture; the unlock handler retries.
      }
    }
  }

  /** Silent oscillator → gain=0 → destination. Keeps AudioContext running. */
  _startKeepAlive() {
    if (!this.audioCtx) return;
    this._keepAliveOsc = this.audioCtx.createOscillator();
    this._keepAliveGain = this.audioCtx.createGain();
    this._keepAliveGain.gain.value = 0;
    this._keepAliveOsc.connect(this._keepAliveGain);
    this._keepAliveGain.connect(this.audioCtx.destination);
    this._keepAliveOsc.frequency.value = 440;
    this._keepAliveOsc.start();
  }

  setVolume(v) {
    this.options.volume = v;
    if (this.gainNode) this.gainNode.gain.value = v;
  }

  /* ------------------------------------------------------------------ */
  /* Sample ingestion                                                    */
  /* ------------------------------------------------------------------ */

  /** Drop-in name used by player.js. */
  enqueueFrame(frame) {
    return this.addSample(frame);
  }

  addSample(sampleObj) {
    if (!sampleObj) return false;
    this.sampleQueue.push(sampleObj);
    // Try to schedule immediately so we don't wait up to 10ms for the timer.
    this._scheduleIfReady();
    return true;
  }

  /* ------------------------------------------------------------------ */
  /* Scheduler                                                           */
  /* ------------------------------------------------------------------ */

  _startScheduler() {
    if (this.schedulerTimer) return;
    this.schedulerTimer = window.setInterval(() => {
      this._scheduleIfReady();
      this._compactScheduledSources();
    }, 10);
  }

  _scheduleIfReady() {
    if (!this.audioCtx || !this.startStatus) return;

    // Schedule chunks while we have data and lookahead isn't too long.
    while (true) {
      const lookahead = this.nextPlayTime - this.audioCtx.currentTime;
      if (lookahead > 1.5) break;
      if (this.sampleQueue.length === 0) break;

      // Wait for a full merge group when we already have some headroom.
      if (
        this.sampleQueue.length < this.options.consumeSampleLen &&
        lookahead > 0.3
      ) {
        break;
      }

      const merged = this._buildMergedBuffer();
      if (!merged) break;
      this._playBuffer(merged);
    }
  }

  /** Pull up to `consumeSampleLen` queued PCM frames into one AudioBuffer. */
  _buildMergedBuffer() {
    if (!this.audioCtx || this.sampleQueue.length === 0) return null;

    const want = Math.min(
      this.options.consumeSampleLen,
      this.sampleQueue.length,
    );

    let totalSamples = 0;
    let channels = this.sampleQueue[0].channels;
    let sampleRate = this.sampleQueue[0].sampleRate;
    let firstPts = null;

    for (let i = 0; i < want; i += 1) {
      const f = this.sampleQueue[i];
      // If a frame's channel/sampleRate diverges, stop merging here so we
      // don't blend incompatible buffers.
      if (f.channels !== channels || f.sampleRate !== sampleRate) {
        if (i === 0) {
          channels = f.channels;
          sampleRate = f.sampleRate;
        } else {
          break;
        }
      }
      totalSamples += f.sampleCount;
      if (firstPts === null && Number.isFinite(f.ptsMs)) firstPts = f.ptsMs;
    }
    if (totalSamples === 0) return null;

    const buffer = this.audioCtx.createBuffer(
      channels,
      totalSamples,
      sampleRate,
    );

    const channelData = new Array(channels);
    for (let c = 0; c < channels; c += 1) {
      channelData[c] = buffer.getChannelData(c);
    }

    let writeOffset = 0;
    for (let k = 0; k < want; k += 1) {
      const f = this.sampleQueue[0];
      if (f.channels !== channels || f.sampleRate !== sampleRate) break;
      this.sampleQueue.shift();

      const cnt = f.sampleCount;
      const pcm = f.pcm;
      for (let c = 0; c < channels; c += 1) {
        const out = channelData[c];
        for (let i = 0; i < cnt; i += 1) {
          out[writeOffset + i] = pcm[i * channels + c];
        }
      }
      writeOffset += cnt;
    }

    return { buffer, ptsMs: firstPts };
  }

  _playBuffer(merged) {
    const src = this.audioCtx.createBufferSource();
    src.buffer = merged.buffer;
    src.connect(this.gainNode);

    const now = this.audioCtx.currentTime;
    const startAt = Math.max(this.nextPlayTime, now + 0.02);

    if (this.mediaOffsetSec === null && Number.isFinite(merged.ptsMs)) {
      this.mediaOffsetSec = merged.ptsMs / 1000 - startAt;
    }

    src.start(startAt);
    src._endsAt = startAt + merged.buffer.duration;

    this.scheduledSources.push(src);
    if (this.scheduledSources.length > this.maxScheduledSources) {
      this.scheduledSources.shift();
    }

    this.nextPlayTime = src._endsAt;

    if (Number.isFinite(merged.ptsMs)) {
      this.playTimestamp = merged.ptsMs / 1000;
      this.playStartedAt = startAt;
    }
  }

  _compactScheduledSources() {
    if (!this.audioCtx || this.scheduledSources.length === 0) return;
    const now = this.audioCtx.currentTime;
    while (
      this.scheduledSources.length > 0 &&
      this.scheduledSources[0]._endsAt <= now
    ) {
      const dead = this.scheduledSources.shift();
      try {
        dead.disconnect(this.gainNode);
      } catch (_) {
        /* already disconnected */
      }
    }
  }

  /* ------------------------------------------------------------------ */
  /* play / pause / stop (audio-core API)                                */
  /* ------------------------------------------------------------------ */

  play() {
    this.startStatus = true;
    this._tryResume();
    this._scheduleIfReady();
  }

  pause() {
    this.startStatus = false;
    while (this.scheduledSources.length > 0) {
      const s = this.scheduledSources.shift();
      try {
        s.stop();
        s.disconnect(this.gainNode);
      } catch (_) {
        /* already finished */
      }
    }
    if (this.audioCtx) this.nextPlayTime = this.audioCtx.currentTime;
  }

  stop() {
    this.pause();
    this.cleanQueue();
    this.nextBuffer = null;
    this.mediaOffsetSec = null;
  }

  cleanQueue() {
    this.sampleQueue.length = 0;
  }

  /* ------------------------------------------------------------------ */
  /* Compat API used by player.js                                        */
  /* ------------------------------------------------------------------ */

  /** Audio media time in seconds, or null until first frame is scheduled. */
  getMediaTimeSec() {
    if (!this.audioCtx || this.mediaOffsetSec === null) return null;
    return this.audioCtx.currentTime + this.mediaOffsetSec;
  }

  /** audio-core formula — kept for callers that want the wall-clock variant. */
  getAlignVPTS() {
    if (!this.audioCtx) return 0;
    return this.playTimestamp + (this.audioCtx.currentTime - this.playStartedAt);
  }

  getBufferedSeconds() {
    if (!this.audioCtx) return 0;
    return Math.max(0, this.nextPlayTime - this.audioCtx.currentTime);
  }

  reset() {
    this.cleanQueue();
    this.nextBuffer = null;
    this.mediaOffsetSec = null;
    while (this.scheduledSources.length > 0) {
      const s = this.scheduledSources.shift();
      try {
        s.stop();
        s.disconnect(this.gainNode);
      } catch (_) {
        /* already finished */
      }
    }
    if (this.audioCtx) this.nextPlayTime = this.audioCtx.currentTime;
    this.startStatus = true;
  }

  destroy() {
    if (this.schedulerTimer) {
      clearInterval(this.schedulerTimer);
      this.schedulerTimer = 0;
    }
    this.stop();
    if (this._keepAliveOsc) {
      try {
        this._keepAliveOsc.stop();
      } catch (_) {
        /* already stopped */
      }
      this._keepAliveOsc.disconnect();
      this._keepAliveOsc = null;
    }
    if (this._keepAliveGain) {
      this._keepAliveGain.disconnect();
      this._keepAliveGain = null;
    }
    if (this._unlockBound) {
      document.removeEventListener("pointerdown", this._unlockBound);
      document.removeEventListener("touchend", this._unlockBound);
      this._unlockBound = null;
    }
    if (this.audioCtx) {
      this.audioCtx.close().catch(() => {});
      this.audioCtx = null;
    }
  }
}

export default AudioCore;
