/**
 * VQEG CAP telemetry report (pilot ``CapReport`` / ``cap_reports`` IPC).
 * Co-sim today: one snapshot per collaboration tick; event-driven 1/s is future work.
 */

const EPS = 1e-8;

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
