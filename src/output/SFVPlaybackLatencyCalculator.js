/**
 * Derive user-perceived start latencies from normalized runtime events.
 *
 * `PLAYBACK_STARTED` means HTMLMediaElement `playing` in the browser and the
 * simulated transition from startup to advancing playback in the simulator.
 * It is not a decoded/rendered first-frame measurement.
 */
export function calculatePlaybackLatency({dataset, userEvents = [], playbackEvents = [], measurementSource = 'unknown', allEvents = []}) {
  const firstVideoId = dataset.videos[0]?.videoId ?? null;
  const starts = playbackEvents.filter(event =>
    event.eventType === 'PLAYBACK_STARTED' && Number.isFinite(event.time)
  );
  const firstPlayRequest = playbackEvents.find(event =>
    event.eventType === 'PLAY_REQUESTED' && event.videoId === firstVideoId && Number.isFinite(event.time)
  );
  const sessionStart = allEvents.find(event => event.eventType === 'SESSION_STARTED' && Number.isFinite(event.time));
  const referenceTime = sessionStart?.time ?? firstPlayRequest?.time ?? null;
  const firstPlayback = referenceTime !== null
    ? starts.find(event => event.videoId === firstVideoId && event.time >= referenceTime)
    : null;

  const initial = {
    video_id: firstVideoId,
    session_started_at_s: sessionStart?.time ?? null,
    start_reference: sessionStart ? 'session_start' : 'play_request',
    play_requested_at_s: firstPlayRequest?.time ?? null,
    playback_started_at_s: firstPlayback?.time ?? null,
    delay_s: firstPlayback ? Math.max(0, firstPlayback.time - referenceTime) : null,
    status: referenceTime === null ? 'not_requested' : firstPlayback ? 'started' : 'not_started'
  };

  const swipes = userEvents.filter(event =>
    event.eventType === 'SWIPE' && Number.isFinite(event.time)
  );
  const swipeToPlayback = swipes.map((swipe, index) => {
    const nextSwipeTime = swipes[index + 1]?.time ?? Infinity;
    const firstStart = starts.find(event =>
      event.videoId === swipe.toVideoId &&
      event.time >= swipe.time && event.time < nextSwipeTime
    );
    return {
      from_video_id: swipe.fromVideoId,
      to_video_id: swipe.toVideoId,
      swipe_at_s: swipe.time,
      playback_started_at_s: firstStart?.time ?? null,
      delay_s: firstStart ? Math.max(0, firstStart.time - swipe.time) : null,
      status: firstStart ? 'started' : Number.isFinite(nextSwipeTime)
        ? 'interrupted_by_next_swipe' : 'not_started'
    };
  });

  return {
    measurement_source: measurementSource,
    initial,
    swipe_to_playback: swipeToPlayback
  };
}
