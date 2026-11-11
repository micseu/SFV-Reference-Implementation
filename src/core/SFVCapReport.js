/**
 * VQEG CAP telemetry report (pilot ``CapReport`` / ``cap_reports`` IPC).
 * Reports are event-driven: ``SFVCapReportEmitter`` emits on stall edges, video switches and
 * buffer threshold crossings, at most once per ``minIntervalS`` of session time per UE.
 */

const EPS = 1e-8;

export const DEFAULT_CAP_BUFFER_DELTA_S = 1.0;
export const DEFAULT_CAP_MIN_INTERVAL_S = 1.0;

export function countSwipesInWindow(userEvents, timeS, windowS = 1, eps = EPS) {
  if (!Array.isArray(userEvents)) return 0;
  return userEvents.filter(
    event =>
      event?.eventType === 'SWIPE' &&
      Number.isFinite(event.time) &&
      event.time > timeS - windowS &&
      event.time <= timeS + eps
  ).length;
}

function playableBufferSeconds(playback) {
  const positionS = playback.positionS ?? 0;
  if (typeof playback.bufferEnd === 'function') {
    return Math.max(0, playback.bufferEnd() - positionS);
  }
  const snap = typeof playback.snapshot === 'function' ? playback.snapshot() : playback;
  const ranges = snap.bufferRanges ?? [];
  const bufferEnd = ranges.length
    ? Math.max(...ranges.map(range => range.endS ?? range.end ?? 0))
    : 0;
  return Math.max(0, bufferEnd - (snap.positionS ?? positionS));
}

function stallFlag(playback) {
  if (typeof playback.stalled === 'boolean') return playback.stalled;
  if (typeof playback.snapshot === 'function') return !!playback.snapshot().stalled;
  return false;
}

function currentVideoId(playback) {
  if (playback.videoId != null && playback.videoId !== '') return String(playback.videoId);
  if (typeof playback.snapshot === 'function') {
    const id = playback.snapshot().videoId;
    return id == null ? '' : String(id);
  }
  return '';
}

/**
 * @param {{ timeS: number, playback: object, userEvents?: object[], swipeWindowS?: number }} args
 */
export function buildCapReportFromSession({ timeS, playback, userEvents = [], swipeWindowS = 1 }) {
  if (!Number.isFinite(timeS) || timeS < 0)
    throw new TypeError('buildCapReportFromSession: invalid timeS');
  if (!playback || typeof playback !== 'object')
    throw new TypeError('buildCapReportFromSession: playback required');
  return Object.freeze({
    time_s: timeS,
    is_stalled: stallFlag(playback),
    playable_buffer_s: playableBufferSeconds(playback),
    current_video_id: currentVideoId(playback),
    swipe_rate_per_s: countSwipesInWindow(userEvents, timeS, swipeWindowS)
  });
}

/**
 * Per-UE CAP report gate. Changes are compared with the last emitted report, so a transition
 * suppressed by the rate limit is emitted (coalesced) at the first poll after the window reopens.
 */
export class SFVCapReportEmitter {
  constructor({
    bufferDeltaS = DEFAULT_CAP_BUFFER_DELTA_S,
    minIntervalS = DEFAULT_CAP_MIN_INTERVAL_S
  } = {}) {
    if (!Number.isFinite(bufferDeltaS) || bufferDeltaS <= 0) {
      throw new TypeError('SFVCapReportEmitter: bufferDeltaS must be positive');
    }
    if (!Number.isFinite(minIntervalS) || minIntervalS < 0) {
      throw new TypeError('SFVCapReportEmitter: minIntervalS must be non-negative');
    }
    this.bufferDeltaS = bufferDeltaS;
    this.minIntervalS = minIntervalS;
    this.lastReport = null;
  }

  hasTransition(report) {
    const last = this.lastReport;
    if (last == null) return true;
    return (
      report.is_stalled !== last.is_stalled ||
      report.current_video_id !== last.current_video_id ||
      Math.abs(report.playable_buffer_s - last.playable_buffer_s) >= this.bufferDeltaS - EPS
    );
  }

  /** Returns the report to emit, or null. ``force`` bypasses the rate limit (final drain). */
  poll(report, { force = false } = {}) {
    if (!this.hasTransition(report)) return null;
    if (
      !force &&
      this.lastReport != null &&
      report.time_s - this.lastReport.time_s < this.minIntervalS - EPS
    )
      return null;
    this.lastReport = report;
    return report;
  }
}
