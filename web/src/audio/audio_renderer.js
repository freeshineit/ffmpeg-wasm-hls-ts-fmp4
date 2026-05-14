export class AudioRenderer {
  constructor() {
    this.audioContext = null;
    this.startedAt = 0;
    this.nextPlayTime = 0;
    this.mediaOffsetSec = null;
  }

  async init() {
    if (!this.audioContext) {
      this.audioContext = new AudioContext({ latencyHint: "interactive" });
      this.startedAt = this.audioContext.currentTime;
      this.nextPlayTime = this.startedAt;
    }
    if (this.audioContext.state !== "running") {
      await this.audioContext.resume();
    }
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
    const startAt = Math.max(this.nextPlayTime, now);

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
}
