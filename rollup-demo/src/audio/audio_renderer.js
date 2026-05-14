export class AudioRenderer {
  constructor() {
    this.audioContext = null;
    this.startedAt = 0;
    this.nextPlayTime = 0;
    this.mediaOffsetSec = null;
    this._keepAliveOsc = null;
    this._keepAliveGain = null;
    this._unlockBound = null;
  }

  async init() {
    if (this.audioContext) {
      return this._tryResume();
    }

    this.audioContext = new AudioContext({ latencyHint: "interactive" });
    this.startedAt = this.audioContext.currentTime;
    this.nextPlayTime = this.startedAt;

    // Silent oscillator keeps the Web Audio graph active,
    // preventing iOS from suspending the AudioContext.
    this._startKeepAlive();

    // If iOS suspends the context (e.g. app background), auto-resume.
    this.audioContext.addEventListener("statechange", () => {
      console.warn("1111", this.audioContext && this.audioContext.state);
      if (this.audioContext && this.audioContext.state === "suspended") {
        this.audioContext.resume();
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

  enqueueFrame(frame) {
    if (!this.audioContext) {
      return;
    }

    const { channels, sampleRate, sampleCount, pcm, ptsMs } = frame;
    const audioBuffer = this.audioContext.createBuffer(
      channels,
      sampleCount,
      sampleRate,
    );

    for (let ch = 0; ch < channels; ch += 1) {
      const channelData = audioBuffer.getChannelData(ch);
      for (let i = 0; i < sampleCount; i += 1) {
        channelData[i] = pcm[i * channels + ch];
      }
    }

    const source = this.audioContext.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(this.audioContext.destination);

    const now = this.audioContext.currentTime;
    const startAt = Math.max(this.nextPlayTime, now + 0.02);

    if (this.mediaOffsetSec === null && Number.isFinite(ptsMs)) {
      this.mediaOffsetSec = ptsMs / 1000 - startAt;
    }

    source.start(startAt);
    this.nextPlayTime = startAt + audioBuffer.duration;
  }

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
    this.nextPlayTime = this.audioContext ? this.audioContext.currentTime : 0;
    this.mediaOffsetSec = null;
  }

  destroy() {
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
    if (this.audioContext) {
      this.audioContext.close();
      this.audioContext = null;
    }
  }
}
