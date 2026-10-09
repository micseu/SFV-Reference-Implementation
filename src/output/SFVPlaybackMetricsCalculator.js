/**
 * Shared, event-derived playback metrics for real browser and virtual-time DES.
 * "Played" here means media-position advancement attributed to an appended
 * representation; for the browser this is an HTMLMediaElement-timeupdate proxy,
 * NOT decoded/presented frame telemetry.
 */
const EPS = 1e-7;
const finite = value => Number.isFinite(value);

function knownSegments(video) {
  return video.representations?.video?.[0]?.segments ?? [];
}

function bitrateFor(video, representationId) {
  const rep = video.representations?.video?.find(r => String(r.id) === String(representationId));
  return finite(rep?.bitrateKbps) ? rep.bitrateKbps : null;
}

function appendMap(allEvents) {
  const map = new Map();
  for (const event of allEvents) {
    if (event.eventType !== 'RESOURCE_APPENDED' || !finite(event.time)) continue;
    if (event.videoId == null || event.segmentIndex == null || event.representationId == null)
      continue;
    const key = `${event.videoId}|${event.segmentIndex}`;
    const entries = map.get(key) ?? [];
    entries.push({ time: event.time, representationId: String(event.representationId) });
    map.set(key, entries);
  }
  for (const entries of map.values()) entries.sort((a, b) => a.time - b.time);
  return map;
}

function representationAt(map, videoId, index, time) {
  const entries = map.get(`${videoId}|${index}`) ?? [];
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].time <= time + EPS) return entries[i].representationId;
  }
  return null;
}

function sampleType(event) {
  return event.eventType === 'PLAYBACK_STARTED' || event.eventType === 'PLAYBACK_POSITION_SAMPLE';
}

function progressForVideo(video, playbackEvents, assignments) {
  const samples = playbackEvents.filter(
    e => e.videoId === video.videoId && sampleType(e) && finite(e.time) && finite(e.positionS)
  );
  const intervals = [];
  let unassignedDurationS = 0;
  let prev = null;
  const segments = knownSegments(video);
  for (const sample of samples) {
    if (!prev || sample.discontinuity === true || sample.positionS < prev.positionS - EPS) {
      prev = sample;
      continue;
    }
    if (sample.positionS <= prev.positionS + EPS) {
      prev = sample;
      continue;
    }
    const from = prev.positionS,
      to = sample.positionS;
    let cursor = from;
    let guard = 0;
    while (cursor < to - EPS && guard++ < 10000) {
      const seg = segments.find(
        s =>
          finite(s.startS) &&
          finite(s.durationS) &&
          s.startS <= cursor + EPS &&
          cursor < s.startS + s.durationS - EPS
      );
      const stop = seg
        ? Math.min(to, seg.startS + seg.durationS)
        : Math.min(to, ...segments.filter(s => s.startS > cursor + EPS).map(s => s.startS));
      if (!finite(stop) || stop <= cursor + EPS) break;
      const span = to - from;
      const startTime = prev.time + ((cursor - from) / span) * (sample.time - prev.time);
      const endTime = prev.time + ((stop - from) / span) * (sample.time - prev.time);
      const representationId = seg
        ? representationAt(assignments, video.videoId, seg.index, startTime)
        : null;
      if (representationId == null) unassignedDurationS += stop - cursor;
      else
        intervals.push({
          video_id: video.videoId,
          representation_id: representationId,
          bitrate_kbps: bitrateFor(video, representationId),
          segment_index: seg.index,
          start_at_s: startTime,
          end_at_s: endTime,
          start_position_s: cursor,
          end_position_s: stop,
          played_duration_s: stop - cursor
        });
      cursor = stop;
    }
    prev = sample;
  }
  return { intervals, unassignedDurationS };
}

function consolidateIntervals(rows) {
  const out = [];
  for (const row of rows) {
    const last = out.at(-1);
    // Keep pauses and stalls as separate intervals; never count that wall-time as played media.
    if (
      last &&
      last.representation_id === row.representation_id &&
      Math.abs(last.end_position_s - row.start_position_s) < EPS &&
      row.start_at_s - last.end_at_s <= 0.3
    ) {
      last.end_at_s = row.end_at_s;
      last.end_position_s = row.end_position_s;
      last.played_duration_s += row.played_duration_s;
      last.segment_index_end = row.segment_index;
    } else out.push({ ...row, segment_index_end: row.segment_index });
  }
  return out;
}

function stallIntervals(videoId, events, endTime, terminationReason) {
  const ordered = events.filter(e => finite(e.time)).sort((a, b) => a.time - b.time);
  const out = [];
  let pending = null;
  function close(time, reason) {
    if (!pending) return;
    const end = finite(time) ? Math.max(pending.started_at_s, time) : null;
    out.push({
      ...pending,
      ended_at_s: end,
      observed_until_s: end,
      duration_s: end === null ? null : end - pending.started_at_s,
      status: reason
    });
    pending = null;
  }
  for (const event of ordered) {
    if (event.eventType === 'STALL_STARTED' && event.videoId === videoId && !pending) {
      pending = { video_id: videoId, started_at_s: event.time };
    } else if (pending && event.videoId === videoId && event.eventType === 'STALL_RECOVERED')
      close(event.time, 'recovered');
    else if (pending && event.videoId === videoId && event.eventType === 'STALL_ENDED')
      close(event.time, event.reason ?? 'interrupted');
    else if (pending && event.videoId === videoId && event.eventType === 'VIDEO_COMPLETED')
      close(event.time, 'video_completed');
    else if (pending && event.eventType === 'SWIPE' && event.fromVideoId === videoId)
      close(event.time, 'swipe');
  }
  if (pending && terminationReason === 'session_end' && finite(endTime)) {
    close(endTime, 'session_end');
  }
  if (pending) {
    const observedUntil = Math.max(
      pending.started_at_s,
      finite(endTime) ? endTime : pending.started_at_s
    );
    out.push({
      ...pending,
      ended_at_s: null,
      observed_until_s: observedUntil,
      duration_s: observedUntil - pending.started_at_s,
      status: 'open_at_export'
    });
  }
  return out;
}

/** @returns normalized timelines, transitions and per-video/session summaries */
export function calculatePlaybackMetrics({
  dataset,
  playbackEvents = [],
  userEvents = [],
  allEvents = [],
  endTimeS = null,
  terminationReason = 'simulation_cutoff'
}) {
  const assignments = appendMap(allEvents);
  const timeline = [];
  const perVideo = {};
  for (const video of dataset.videos) {
    const progress = progressForVideo(video, playbackEvents, assignments);
    const intervals = consolidateIntervals(progress.intervals);
    const durations = {};
    for (const item of intervals)
      durations[item.representation_id] =
        (durations[item.representation_id] ?? 0) + item.played_duration_s;
    const stalls = stallIntervals(
      video.videoId,
      [...playbackEvents, ...userEvents],
      endTimeS,
      terminationReason
    );
    perVideo[video.videoId] = {
      representation_intervals: intervals,
      representation_played_duration_s: durations,
      unattributed_played_duration_s: progress.unassignedDurationS,
      stall_events: stalls,
      stall_count: stalls.length,
      stall_duration_s: stalls.reduce((sum, s) => sum + s.duration_s, 0),
      quality_switch_count: 0
    };
    timeline.push(...intervals);
  }
  timeline.sort((a, b) => a.start_at_s - b.start_at_s);
  const transitions = [];
  let prev = null;
  for (const entry of timeline) {
    if (!prev) {
      prev = entry;
      continue;
    }
    const cross = prev.video_id !== entry.video_id;
    const diff = cross
      ? prev.bitrate_kbps == null || entry.bitrate_kbps == null
        ? null
        : prev.bitrate_kbps !== entry.bitrate_kbps
      : prev.representation_id !== entry.representation_id;
    if (cross || diff) {
      const transition = {
        scope: cross ? 'between_videos' : 'within_video',
        at_s: entry.start_at_s,
        video_id: entry.video_id,
        from_video_id: prev.video_id,
        to_video_id: entry.video_id,
        from_representation_id: prev.representation_id,
        to_representation_id: entry.representation_id,
        from_bitrate_kbps: prev.bitrate_kbps,
        to_bitrate_kbps: entry.bitrate_kbps,
        playback_position_s: entry.start_position_s,
        is_quality_change: diff
      };
      transitions.push(transition);
      if (diff === true) perVideo[entry.video_id].quality_switch_count++;
    }
    prev = entry;
  }
  const durationMap = {};
  for (const [videoId, video] of Object.entries(perVideo))
    for (const [representationId, duration] of Object.entries(
      video.representation_played_duration_s
    ))
      durationMap[`${videoId}|${representationId}`] = duration;
  return {
    metrics_schema_version: 1,
    measurement_source: 'playhead_progress_attributed_to_appended_representation',
    representation_intervals: timeline,
    quality_transitions: transitions,
    quality_switches: transitions.filter(t => t.is_quality_change === true),
    stall_events: Object.values(perVideo).flatMap(v => v.stall_events),
    representation_played_duration_s: durationMap,
    quality_switch_count_total: transitions.filter(t => t.is_quality_change === true).length,
    quality_switch_count_within_video: transitions.filter(
      t => t.scope === 'within_video' && t.is_quality_change === true
    ).length,
    quality_switch_count_between_videos: transitions.filter(
      t => t.scope === 'between_videos' && t.is_quality_change === true
    ).length,
    stall_count_total: Object.values(perVideo).reduce((n, v) => n + v.stall_count, 0),
    stall_duration_total_s: Object.values(perVideo).reduce((n, v) => n + v.stall_duration_s, 0),
    per_video: perVideo
  };
}
