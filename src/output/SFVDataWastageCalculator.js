function deliveredBytes(request) {
  return request.finalBytesDelivered ?? request.bytesDelivered ?? 0;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function segmentKey(resource) {
  return `${resource.videoId}|${resource.mediaType ?? 'video'}|${resource.segmentIndex}`;
}

function representationKey(videoId, mediaType, representationId) {
  return `${videoId}|${mediaType ?? 'video'}|${representationId}`;
}

function buildBitrateMap(dataset) {
  const bitrates = new Map();
  for (const video of dataset.videos) {
    for (const [mediaType, representations] of Object.entries(video.representations ?? {})) {
      for (const representation of representations) {
        bitrates.set(
          representationKey(video.videoId, mediaType, representation.id),
          representation.bitrateKbps ?? Number.NaN
        );
      }
    }
  }
  return bitrates;
}

function buildSelectedRepresentationMap(playbacks) {
  const selected = new Map();
  for (const [videoId, playback] of Object.entries(playbacks)) {
    for (const entry of playback.rendered ?? []) {
      selected.set(`${videoId}|video|${entry.segmentIndex}`, {
        representationId: entry.representationId,
        time: entry.time,
        playbackPositionS: entry.playbackPositionS ?? 0
      });
    }
  }
  return selected;
}

function consumedFraction(request, watchDurationS, selectedRepresentation) {
  const resource = request.resource;
  if (
    !selectedRepresentation ||
    selectedRepresentation.representationId !== resource.representationId
  ) {
    return 0;
  }
  if (
    !Number.isFinite(resource.startS) ||
    !Number.isFinite(resource.durationS) ||
    resource.durationS <= 0
  ) {
    return 0;
  }
  return clamp((watchDurationS - resource.startS) / resource.durationS, 0, 1);
}

function findRepresentationSupersededRequests({ dataset, requests, playbacks }) {
  const bitrates = buildBitrateMap(dataset);
  const selected = buildSelectedRepresentationMap(playbacks);
  const superseded = new Set();

  for (const request of requests) {
    const resource = request.resource;
    if (resource?.resourceType !== 'media' || request.state !== 'COMPLETED') {
      continue;
    }

    const selection = selected.get(segmentKey(resource));
    if (!selection || selection.representationId === resource.representationId) {
      continue;
    }

    const originalBitrate = bitrates.get(
      representationKey(resource.videoId, resource.mediaType, resource.representationId)
    );
    const selectedBitrate = bitrates.get(
      representationKey(resource.videoId, resource.mediaType, selection.representationId)
    );

    if (!Number.isFinite(originalBitrate) || !Number.isFinite(selectedBitrate)) {
      continue;
    }
    if (selectedBitrate <= originalBitrate) {
      continue;
    }
    if (!Number.isFinite(request.endTime) || request.endTime > selection.time + 1e-9) {
      continue;
    }
    if (Number.isFinite(resource.startS) && selection.playbackPositionS > resource.startS + 1e-9) {
      continue;
    }

    superseded.add(request.requestId);
  }

  return superseded;
}

/**
 * Data wastage is recorded only when delivered media bytes are known to be
 * unusable for the remainder of the session:
 *   - a video is abandoned by a swipe;
 *   - a completed lower-quality representation is superseded by a selected
 *     higher-quality representation of the same logical segment; or
 *   - the user session explicitly ends.
 *
 * A simulation cutoff is not a session end. Bytes that might still become
 * useful are reported as unresolved rather than data wastage.
 */
export function calculateDataWastage({
  dataset,
  requests,
  userEvents,
  playbacks,
  terminationReason
}) {
  const swipedVideos = new Set(
    userEvents.filter(event => event.eventType === 'SWIPE').map(event => event.fromVideoId)
  );
  const selectedRepresentations = buildSelectedRepresentationMap(playbacks);
  const representationSuperseded = findRepresentationSupersededRequests({
    dataset,
    requests,
    playbacks
  });
  const sessionEnded = terminationReason === 'session_end';

  const byVideo = new Map(
    dataset.videos.map(video => [
      video.videoId,
      {
        total: 0,
        reasons: {
          swipe: 0,
          representation_superseded: 0,
          cache_admission_rejected: 0,
          session_end: 0
        },
        unresolvedAtCutoff: 0
      }
    ])
  );

  for (const request of requests) {
    const resource = request.resource;
    if (resource?.resourceType !== 'media') {
      continue;
    }

    const bytes = deliveredBytes(request);
    if (!(bytes > 0)) {
      continue;
    }

    const videoResult = byVideo.get(resource.videoId);
    if (!videoResult) {
      continue;
    }

    if (request.cacheAdmitted === false) {
      videoResult.total += bytes;
      videoResult.reasons.cache_admission_rejected += bytes;
      continue;
    }
    if (representationSuperseded.has(request.requestId)) {
      videoResult.total += bytes;
      videoResult.reasons.representation_superseded += bytes;
      continue;
    }

    const playback = playbacks[resource.videoId] ?? { positionS: 0, rendered: [] };
    const selected = selectedRepresentations.get(segmentKey(resource));
    const consumed = consumedFraction(request, playback.positionS ?? 0, selected);
    const unconsumedBytes = bytes * (1 - consumed);

    if (swipedVideos.has(resource.videoId)) {
      videoResult.total += unconsumedBytes;
      videoResult.reasons.swipe += unconsumedBytes;
      continue;
    }

    if (sessionEnded) {
      videoResult.total += unconsumedBytes;
      videoResult.reasons.session_end += unconsumedBytes;
      continue;
    }

    videoResult.unresolvedAtCutoff += unconsumedBytes;
  }

  const total = {
    total: 0,
    reasons: {
      swipe: 0,
      representation_superseded: 0,
      cache_admission_rejected: 0,
      session_end: 0
    },
    unresolvedAtCutoff: 0
  };

  for (const value of byVideo.values()) {
    total.total += value.total;
    total.reasons.swipe += value.reasons.swipe;
    total.reasons.representation_superseded += value.reasons.representation_superseded;
    total.reasons.cache_admission_rejected += value.reasons.cache_admission_rejected;
    total.reasons.session_end += value.reasons.session_end;
    total.unresolvedAtCutoff += value.unresolvedAtCutoff;
  }

  return { byVideo, total };
}
