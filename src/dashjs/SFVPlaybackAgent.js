/** Read-only browser observation adapter: never creates media requests. */
export class SFVPlaybackAgent {
  constructor(videoElement) {
    this.video = videoElement;
    this.videoId = null;
    this.bufferedSegments = new Set();
    this.rendered = [];
    this.stalls = [];
    this.ready = false;
  }
  activate(videoId) {
    this.videoId = videoId;
    this.bufferedSegments.clear();
    this.rendered = [];
    this.stalls = [];
    this.ready = false;
  }
  append(resource) {
    if (resource.videoId !== this.videoId) throw new Error('Append to inactive video');
    if (resource.resourceType === 'media') this.bufferedSegments.add(resource.segmentIndex);
  }
  snapshot() {
    const ranges = [];
    if (this.ready)
      for (let i = 0; i < this.video.buffered.length; i++)
        ranges.push({ startS: this.video.buffered.start(i), endS: this.video.buffered.end(i) });
    return {
      videoId: this.videoId,
      positionS: this.ready && Number.isFinite(this.video.currentTime) ? this.video.currentTime : 0,
      durationS: Number.isFinite(this.video.duration) ? this.video.duration : 0,
      stalled: !!(this.ready && this.video.readyState < 3),
      stalls: structuredClone(this.stalls),
      bufferedSegments: [...this.bufferedSegments],
      bufferRanges: ranges,
      rendered: structuredClone(this.rendered)
    };
  }
}
