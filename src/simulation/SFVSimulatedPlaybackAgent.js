export class SFVSimulatedPlaybackAgent {
  constructor() {
    this.reset();
  }

  reset() {
    this.videoId = null;
    this.positionS = 0;
    this.bufferedSegments = [];
    this.bufferRanges = [];
    this.stalled = true;
    this.started = false;
    this.stallStartedAt = null;
    this.stalls = [];
    this.lastUpdateTime = 0;
    this.durationS = 0;
    this.segmentDurationS = 2;
    this.rendered = [];
    this.startPendingAt = null;
    this.recoveryPendingAt = null;
    this.startupDelayS = 0;
    this.recoveryDelayS = 0;
  }

  activate(videoId, durationS, segmentDurationS, now, timing = {}) {
    this.videoId = videoId;
    this.positionS = 0;
    this.bufferedSegments = [];
    this.bufferRanges = [];
    this.stalled = true;
    this.started = false;
    this.stallStartedAt = null;
    this.stalls = [];
    this.durationS = durationS;
    this.segmentDurationS = segmentDurationS;
    this.lastUpdateTime = now;
    this.rendered = [];
    this.startPendingAt = null;
    this.recoveryPendingAt = null;
    this.startupDelayS = timing.startupDelayS ?? 0;
    this.recoveryDelayS = timing.recoveryDelayS ?? 0;
  }

  append(segment, representationId, now) {
    if (segment.videoId !== this.videoId) {
      return { appended: false, startedNow: false, recoveredNow: false };
    }

    if (!this.bufferedSegments.includes(segment.segmentIndex)) {
      this.bufferedSegments.push(segment.segmentIndex);
      this.bufferedSegments.sort((a, b) => a - b);
    }
    this.#rebuildRanges();

    let startedNow = false;
    let recoveredNow = false;
    if (this.stalled && this.bufferEnd() > this.positionS + 1e-9) {
      if (this.started && this.recoveryDelayS > 0) {
        this.recoveryPendingAt ??= now + this.recoveryDelayS;
      } else if (!this.started && this.startupDelayS > 0) {
        this.startPendingAt ??= now + this.startupDelayS;
      } else {
        if (this.started) {
          this.#closeStall(now);
          recoveredNow = true;
        } else {
          this.started = true;
          startedNow = true;
        }
        this.stalled = false;
        this.stallStartedAt = null;
        this.lastUpdateTime = now;
      }
    }

    this.rendered.push({
      time: now,
      segmentIndex: segment.segmentIndex,
      representationId,
      playbackPositionS: this.positionS
    });
    return { appended: true, startedNow, recoveredNow };
  }

  advanceTo(time) {
    if (time < this.lastUpdateTime - 1e-9) {
      throw new Error('Playback time reversal');
    }

    if (this.stalled && this.bufferEnd() > this.positionS + 1e-9) {
      if (this.startPendingAt !== null && time >= this.startPendingAt - 1e-9) {
        this.started = true;
        this.stalled = false;
        this.lastUpdateTime = this.startPendingAt;
        this.startPendingAt = null;
      } else if (this.recoveryPendingAt !== null && time >= this.recoveryPendingAt - 1e-9) {
        this.#closeStall(this.recoveryPendingAt);
        this.stalled = false;
        this.lastUpdateTime = this.recoveryPendingAt;
        this.recoveryPendingAt = null;
      }
    }
    if (!this.stalled) {
      const end = this.bufferEnd();
      const delta = time - this.lastUpdateTime;
      this.positionS = Math.min(this.positionS + delta, end, this.durationS);
      if (this.positionS >= end - 1e-8 && this.positionS < this.durationS - 1e-8) {
        this.stalled = true;
        this.stallStartedAt = time;
      }
    }
    this.lastUpdateTime = time;
  }

  nextEventTime(now) {
    if (this.stalled) return this.startPendingAt ?? this.recoveryPendingAt ?? Infinity;
    if (this.positionS >= this.durationS - 1e-9) return Infinity;
    // Wake at segment boundaries as well as buffer exhaustion, so a quality
    // transition can be timestamped precisely without creating policy decisions.
    const nextBoundary =
      (Math.floor((this.positionS + 1e-8) / this.segmentDurationS) + 1) * this.segmentDurationS;
    const target = Math.min(this.bufferEnd(), this.durationS, nextBoundary);
    return now + Math.max(0, target - this.positionS);
  }

  bufferEnd() {
    let end = 0;
    for (const index of this.bufferedSegments) {
      const start = index * this.segmentDurationS;
      if (start <= end + 1e-8) {
        end = Math.max(end, start + this.segmentDurationS);
      }
    }
    return end;
  }

  snapshot() {
    return {
      videoId: this.videoId,
      positionS: this.positionS,
      stalled: this.stalled,
      started: this.started,
      bufferedSegments: [...this.bufferedSegments],
      bufferRanges: structuredClone(this.bufferRanges),
      stalls: structuredClone(this.stalls),
      rendered: structuredClone(this.rendered)
    };
  }

  #rebuildRanges() {
    const end = this.bufferEnd();
    this.bufferRanges = end > 0 ? [{ start: 0, end }] : [];
  }

  #closeStall(now) {
    if (this.stallStartedAt !== null && now > this.stallStartedAt) {
      this.stalls.push({
        start: this.stallStartedAt,
        end: now,
        durationS: now - this.stallStartedAt
      });
    }
    this.stallStartedAt = null;
  }
}
