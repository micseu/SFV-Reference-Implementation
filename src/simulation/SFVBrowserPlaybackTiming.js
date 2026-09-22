/**
 * Extract browser *platform timing* for a trace-conditioned replay. The inputs
 * are slot readiness, media-event latency and timeupdate dispatch times, never
 * recorded quality choices, positions, throughput estimates or rule actions.
 * The DES still advances its own playback clock and cannot play before bytes exist.
 */
export function extractBrowserPlaybackTiming(browser, playlist) {
  const events = browser?.events;
  if (!Array.isArray(events)) throw new TypeError('Full browser events required for playback timing');
  const videos = {};
  const valid = number => typeof number === 'number' && Number.isFinite(number) && number >= 0;
  for (const videoId of playlist) {
    const activation = events.find(e => (e.eventType === 'VIDEO_ACTIVATED' || e.eventType === 'SWIPE') &&
      (e.videoId === videoId || e.toVideoId === videoId)) ??
      (videoId === playlist[0] ? events.find(e => e.eventType === 'SESSION_STARTED') : null);
    const slot = events.find(e => e.videoId === videoId && e.eventType === 'PLAYBACK_SLOT_READY');
    const append = events.find(e => e.videoId === videoId && e.eventType === 'RESOURCE_APPENDED' &&
      e.segmentIndex === 0);
    const start = events.find(e => e.videoId === videoId && e.eventType === 'PLAYBACK_STARTED');
    if (!activation || !slot || !append || !start ||
      ![activation.time,slot.time,append.time,start.time].every(valid) ||
      slot.time + 1e-8 < activation.time || start.time + 1e-8 < append.time) {
      throw new TypeError(`Incomplete/noncausal browser playback timing for ${videoId}`);
    }
    const samples = events.filter(e => e.videoId === videoId && e.eventType === 'PLAYBACK_POSITION_SAMPLE' &&
      valid(e.time) && e.time > start.time + 1e-5);
    if (!samples.length) throw new TypeError(`No HTMLMediaElement timeupdate samples for ${videoId}`);
    const offsets = [...new Set(samples.map(e => Math.round((e.time-start.time)*1e6)/1e6))];
    if (offsets.some((t,i) => !valid(t) || t > 1e5 || (i > 0 && t <= offsets[i-1]))) {
      throw new TypeError(`Invalid playback sample schedule for ${videoId}`);
    }
    // Start is gated on actual segment availability; a measured post-append
    // latency is a browser platform input, not a forced absolute start time.
    const recoveries = events.filter(e => e.videoId === videoId && e.eventType === 'STALL_RECOVERED');
    const recoveryDelays = recoveries.map(e => {
      const preceding = events.filter(a => a.videoId === videoId && a.eventType === 'RESOURCE_APPENDED' &&
        a.time <= e.time + 1e-8).at(-1);
      return preceding ? Math.max(0,e.time-preceding.time) : 0;
    });
    videos[videoId] = {
      slotReadyAtS: slot.time,
      startupDelayS: Math.max(0,start.time-append.time),
      recoveryDelayS: recoveryDelays.length ? recoveryDelays[0] : 0,
      sampleOffsetsS: offsets
    };
  }
  return {mode:'browser-platform-trace',videos};
}
