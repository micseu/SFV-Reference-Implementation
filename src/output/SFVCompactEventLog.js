/**
 * A presentation-only view of SFV events, shared by the browser and simulator.
 * All measurements and request accounting continue to use the original events
 * and the common SFVSessionRecordBuilder. No raw events are discarded.
 */
export const COMPACT_EVENT_LOG_SCHEMA_VERSION = 1;
export const COMPACT_EVENT_SOURCES = Object.freeze(['User','Network','Player','ABR','Cache','System']);

/** Filter only the display copy; never mutate the full compact log or raw events. */
export function filterCompactEventLog(log, enabledSources) {
  const selected = new Set(enabledSources);
  return {...log, events: log.events.filter(event => selected.has(event.source))};
}


const finite = value => typeof value === 'number' && Number.isFinite(value);
const text = value => value === undefined || value === null ? '' : String(value);
const humanize = value => text(value).toLowerCase().replace(/_/g, ' ');

function resourceDescription(event) {
  const resource = event.resource ?? event.request?.resource ?? {};
  const type = resource.resourceType ?? event.resourceType ?? 'resource';
  const video = resource.videoId ?? event.videoId;
  const rep = resource.representationId ?? event.representationId;
  const segment = resource.segmentIndex ?? event.segmentIndex;
  const parts = [type, video ? `video ${video}` : null,
    segment !== undefined && segment !== null ? `segment ${segment}` : null,
    rep !== undefined && rep !== null ? `representation ${rep}` : null];
  return parts.filter(Boolean).join(' · ');
}

function eventSource(type) {
  if (/^(SESSION_|SWIPE|USER_|PLAY_REQUESTED)/.test(type)) return 'User';
  if (/^(REQUEST_|RETRY_|NETWORK_|HTTP_|EMULATION_)/.test(type)) return 'Network';
  if (/^(CACHE_|RESOURCE_CACHED|SEGMENT_EVICTED)/.test(type)) return 'Cache';
  if (/^(RULE_|ABR_|SFV_ACTION_|SFV_DISPATCH_)/.test(type)) return 'ABR';
  if (/^(PLAYBACK_|PLAY_|STALL_|VIDEO_|RESOURCE_APPENDED|INIT_APPENDED|APPEND_|REPRESENTATION_)/.test(type)) return 'Player';
  return 'System';
}

function eventDetails(event) {
  const type = event.eventType;
  if (type === 'NETWORK_CAPACITY_CHANGED' || type === 'EMULATION_STARTED') {
    return `Capacity ${finite(event.capacityMbps) ? event.capacityMbps : '?'} Mbit/s`;
  }
  if (type === 'SWIPE') return `Swipe ${text(event.fromVideoId)} → ${text(event.toVideoId)}`;
  if (type === 'SESSION_STARTED') return 'Session started';
  if (type === 'SESSION_ENDED') return 'Session ended';
  if (type === 'SIMULATION_CUTOFF') return 'Simulation measurement cutoff';
  if (type === 'USER_AUTOMATION_EVENT') {
    const at = finite(event.atS) ? ` (planned ${event.atS.toFixed(3)} s)` : '';
    return `${humanize(event.action)}${at}`;
  }
  if (type === 'VIDEO_ACTIVATED') return `Activate video ${text(event.videoId)}`;
  if (type === 'VIDEO_COMPLETED') return `Video ${text(event.videoId)} completed`;
  if (type === 'PLAY_REQUESTED') return `Play video ${text(event.videoId)}${event.cause ? ` (${humanize(event.cause)})` : ''}`;
  if (type === 'PLAYBACK_STARTED') return `Playing video ${text(event.videoId)}`;
  if (type === 'PLAYBACK_POSITION_SAMPLE' || type === 'PLAYBACK_POSITION_UPDATED') {
    return `${text(event.videoId)} at ${finite(event.positionS) ? event.positionS.toFixed(3) : '?'} s`;
  }
  if (type === 'STALL_STARTED') return `Stalling started on video ${text(event.videoId)}`;
  if (type === 'STALL_RECOVERED' || type === 'STALL_ENDED') {
    return `Stalling ended on video ${text(event.videoId)}${event.reason ? ` (${humanize(event.reason)})` : ''}`;
  }
  if (type === 'ABR_DECISION_DIAGNOSTIC') return `Captured replayable input and rule-state snapshot for ${text(event.diagnostic?.rule)}`;
  if (type === 'RULE_DECISION') {
    const actions = (event.actions ?? []).map(a => a.actionType).join(', ');
    return `Rule ${text(event.rule)}: ${actions || 'no action'}${event.reason ? ` (${event.reason})` : ''}`;
  }
  if (type.startsWith('REQUEST_') || type.startsWith('RETRY_')) {
    const bytes = event.request?.bytesDelivered ?? event.bytesDelivered ?? event.finalBytesDelivered;
    return `${humanize(type)}: ${resourceDescription(event)}${event.requestId ? ` [${event.requestId}]` : ''}` +
      (finite(bytes) ? ` · ${Math.round(bytes)} bytes` : '') +
      (event.error ? ` · ${text(event.error)}` : '') +
      (event.cause ? ` · ${humanize(event.cause)}` : '');
  }
  if (type === 'RESOURCE_APPENDED' || type === 'INIT_APPENDED' || type === 'RESOURCE_CACHED') {
    return `${humanize(type)}: ${resourceDescription(event)}`;
  }
  if (type.startsWith('CACHE_') || type.startsWith('APPEND_')) {
    return `${humanize(type)}: ${resourceDescription(event)}${event.reason ? ` · ${humanize(event.reason)}` : ''}` +
      (event.error ? ` · ${text(event.error)}` : '');
  }
  if (type === 'HTTP_FAULT' || type === 'HTTP_TRUNCATED') {
    return `${humanize(type)}: ${text(event.path)}${event.status ? ` HTTP ${event.status}` : ''}`;
  }
  if (event.error) return `${humanize(type)}: ${text(event.error)}`;
  if (event.videoId) return `${humanize(type)}: video ${event.videoId}`;
  return humanize(type);
}

/** Convert one raw event into a stable, small, source-labelled event. */
export function compactEventFromRaw(event) {
  if (!event || typeof event.eventType !== 'string') return null;
  const timestampS = finite(event.time) ? event.time :
    (finite(event.timestampS) ? event.timestampS : (finite(event.atS) ? event.atS : null));
  return {
    timestampS,
    source: eventSource(event.eventType),
    eventType: event.eventType,
    details: eventDetails(event),
    ...(event.eventId !== undefined ? {eventId: event.eventId} : {}),
    ...(event.videoId !== undefined ? {videoId: event.videoId} : {}),
    ...(event.requestId !== undefined ? {requestId: event.requestId} : {})
  };
}

function qualityTransitions(sessionRecord) {
  return (sessionRecord?.playback_metrics?.quality_transitions ?? []).map(transition => ({
    timestampS: finite(transition.at_s) ? transition.at_s : null,
    source: 'Player',
    eventType: transition.is_quality_change === true ? 'QUALITY_SWITCH' : 'VIDEO_QUALITY_TRANSITION',
    videoId: transition.to_video_id,
    details: `${transition.scope === 'between_videos' ? 'Between videos' : 'Within video'}: ` +
      `${transition.from_video_id} / representation ${transition.from_representation_id}` +
      ` → ${transition.to_video_id} / representation ${transition.to_representation_id}` +
      (transition.from_bitrate_kbps !== null && transition.to_bitrate_kbps !== null ?
        ` (${transition.from_bitrate_kbps} → ${transition.to_bitrate_kbps} kbit/s)` : '') +
      (transition.is_quality_change === false ? ' · same bitrate' : '')
  }));
}

/**
 * clockOrigin is "session_start" in the browser and "experiment_start" in
 * the DES. Browser server events need to be mapped to session time *before*
 * passing them as networkEvents; the mapping is approximate across processes.
 */
export function buildCompactEventLog({events=[],networkEvents=[],sessionRecord=null,
  clockOrigin='experiment_start',sessionId=null,ueId=null}={}) {
  const rows = [...events, ...networkEvents].map(compactEventFromRaw).filter(Boolean);
  rows.push(...qualityTransitions(sessionRecord));
  const sorted = rows.map((row,index)=>({row,index})).sort((a,b)=>
    (a.row.timestampS ?? Infinity)-(b.row.timestampS ?? Infinity) || a.index-b.index);
  return {
    schemaVersion: COMPACT_EVENT_LOG_SCHEMA_VERSION,
    clockOrigin,
    sessionId: sessionId ?? sessionRecord?.session_id ?? null,
    ueId: ueId ?? sessionRecord?.ue_id ?? null,
    events: sorted.map(({row})=>row)
  };
}

/** String representation shared by the browser text panel and Node exports. */
export function formatCompactEventLog(log) {
  return log.events.map(event =>
    `${finite(event.timestampS) ? event.timestampS.toFixed(3).padStart(9) : '        ?'} s ` +
    `| ${event.source.padEnd(7)} | ${event.eventType.padEnd(27)} | ${event.details}`
  ).join('\n');
}
