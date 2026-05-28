export class AudioRenderer {
  constructor() {
    this.audioContext = null;
    this.gainNode = null;
    this.startedAt = 0;
    this.nextPlayTime = 0;
    this.mediaOffsetSec = null;

    this._volume = 1.0;
    this._muted = false;
    this._playbackRate = 1.0;

    this._activeSources = []; // currently scheduled, not-yet-finished sources

    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._unlockBound = null;
  }

  async init() {
    if (this.audioContext) {
      return this._tryResume();
    }

    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    this.gainNode = this.audioContext.createGain();
    this.gainNode.gain.value = this._muted ? 0 : this._volume;
    this.gainNode.connect(this.audioContext.destination);

    this.startedAt = this.audioContext.currentTime;
    this.nextPlayTime = this.startedAt;

    // Silent oscillator keeps the Web Audio graph active,
    // preventing iOS from suspending the AudioContext.
    this._startKeepAlive();

    // If iOS suspends the context (e.g. app background), auto-resume.
    this.audioContext.addEventListener("statechange", () => {
      if (this.audioContext && this.audioContext.state === "suspended") {
        // Don't auto-resume if user explicitly paused; leave that to the player.
      }
    });

    // iOS requires a user gesture to start AudioContext.
    // Register a one-shot unlock on the first user interaction.
    this._unlockBound = () => this._tryResume();
    document.addEventListener("pointerdown", this._unlockBound, { once: true });
    document.addEventListener("touchend", this._unlockBound, { once: true });

    return this._tryResume();
  }

  async _tryResume() {
    if (!this.audioContext) return;
    if (this.audioContext.state !== "running") {
      try {
        await this.audioContext.resume();
      } catch (_) {
        // Resuming without a user gesture may be rejected on iOS.
        // The unlock handler will retry on first interaction.
      }
    }
  }

  /** Silent oscillator → gain=0 → destination. Keeps AudioContext running. */
  _startKeepAlive() {
    if (!this.audioContext) return;
    this._keepAliveOsc = this.audioContext.createOscillator();
    this._keepAliveGain = this.audioContext.createGain();
    this._keepAliveGain.gain.value = 0;
    this._keepAliveOsc.connect(this._keepAliveGain);
    this._keepAliveGain.connect(this.audioContext.destination);
    this._keepAliveOsc.frequency.value = 440;
    this._keepAliveOsc.start();
  }

  /* ---------------- API exposed to the player ---------------- */

  setVolume(v) {
    this._volume = Math.max(0, Math.min(1, +v || 0));
    if (this.gainNode) {
      this.gainNode.gain.value = this._muted ? 0 : this._volume;
    }
  }

  setMuted(m) {
    this._muted = !!m;
    if (this.gainNode) {
      this.gainNode.gain.value = this._muted ? 0 : this._volume;
    }
  }

  setPlaybackRate(rate) {
    const r = Math.max(0.25, Math.min(4, +rate || 1));
    const prevRate = this._playbackRate;
    if (r === prevRate) return;
    this._playbackRate = r;

    // Apply rate to active sources AND recalculate nextPlayTime.
    // Without recalculating, the next enqueueFrame would schedule at
    // the old nextPlayTime, causing audio gaps or overlaps.
    const now = this.audioContext ? this.audioContext.currentTime : 0;
    let recalculatedNext = now + 0.02;

    for (const s of this._activeSources) {
      try {
        s.playbackRate.value = r;
        // Each source carries _startAt and its buffer duration so we can
        // re-derive the effective end time after the rate change.
        if (s._startAt != null && s.buffer) {
          const newEndsAt = s._startAt + s.buffer.duration / r;
          s._endsAt = newEndsAt;
          recalculatedNext = Math.max(recalculatedNext, newEndsAt);
        }
      } catch (_) {
        // already finished
      }
    }

    this.nextPlayTime = recalculatedNext;
  }

  async suspend() {
    if (this.audioContext && this.audioContext.state === "running") {
      try {
        await this.audioContext.suspend();
      } catch (_) {
        /* ignore */
      }
    }
  }

  async resume() {
    if (this.audioContext && this.audioContext.state !== "running") {
      try {
        await this.audioContext.resume();
      } catch (_) {
        /* ignore */
      }
    }
  }

  /* ---------------- Frame ingestion ---------------- */

  enqueueFrame(frame) {
    if (!this.audioContext || !this.gainNode) {
      return;
    }

    const { channels, sampleRate, sampleCount, pcm, ptsMs } = frame;
    const audioBuffer = this.audioContext.createBuffer(channels, sampleCount, sampleRate);

    for (let ch = 0; ch < channels; ch += 1) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sampleCount; i += 1) {
        channelData[i] = pcm[i * channels + ch];
      }
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.playbackRate.value = this._playbackRate;
    source.connect(this.gainNode);

    const now = this.audioContext.currentTime;
    const startAt = Math.max(this.nextPlayTime, now + 0.02);

    if (this.mediaOffsetSec === null && Number.isFinite(ptsMs)) {
      this.mediaOffsetSec = ptsMs / 1000 - startAt;
    }

    source.start(startAt);
    source._startAt = startAt;
    const effectiveDuration = audioBuffer.duration / this._playbackRate;
    const endsAt = startAt + effectiveDuration;
    source._endsAt = endsAt;
    this._activeSources.push(source);
    source.onended = () => {
      const idx = this._activeSources.indexOf(source);
      if (idx >= 0) this._activeSources.splice(idx, 1);
    };

    this.nextPlayTime = endsAt;
  }

  /* ---------------- Clock helpers ---------------- */

  getBufferedSeconds() {
    if (!this.audioContext) {
      return 0;
    }
    return Math.max(0, this.nextPlayTime - this.audioContext.currentTime);
  }

  getMediaTimeSec() {
    if (!this.audioContext || this.mediaOffsetSec === null) {
      return null;
    }
    return this.audioContext.currentTime + this.mediaOffsetSec;
  }

  reset() {
    for (const s of this._activeSources) {
      try {
        s.stop();
        s.disconnect();
      } catch (_) {
        /* already finished */
      }
    }
    this._activeSources.length = 0;
    this.nextPlayTime = this.audioContext ? this.audioContext.currentTime : 0;
    this.mediaOffsetSec = null;
  }

  destroy() {
    this.reset();
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
    if (this.gainNode) {
      this.gainNode.disconnect();
      this.gainNode = null;
    }
    if (this._unlockBound) {
      document.removeEventListener("pointerdown", this._unlockBound);
      document.removeEventListener("touchend", this._unlockBound);
      this._unlockBound = null;
    }
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
