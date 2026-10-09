import { ACTION } from '../core/constants.js';
import { DashStyleThroughputEstimator } from './DashStyleThroughputEstimator.js';

export class BaseSFVRule {
  constructor(name) {
    this.name = name;
    this.estimator = new DashStyleThroughputEstimator();
    this.config = {};
  }

  reset(config = {}, seed = 1) {
    this.config = structuredClone(config);
    this.seed = seed;
    this.estimator.reset(config.throughput);
    this.processedTerminalRequests = new Set();
  }

  onObservationBatch(events) {
    for (const event of events) {
      if (
        event.eventType === 'REQUEST_COMPLETED' &&
        event.request &&
        !this.processedTerminalRequests.has(event.request.requestId)
      ) {
        this.estimator.addCompletedRequest(event.request);
        this.processedTerminalRequests.add(event.request.requestId);
      }
    }
  }

  getState() {
    return {
      config: structuredClone(this.config),
      seed: this.seed,
      processed: [...this.processedTerminalRequests],
      estimator: this.estimator.getState()
    };
  }

  setState(state) {
    this.config = structuredClone(state.config);
    this.seed = state.seed;
    this.processedTerminalRequests = new Set(state.processed);
    this.estimator.setState(state.estimator);
  }

  selectRepresentation(video, preferredKbps = Number.NaN) {
    const representations = (video.representations?.video ?? [])
      .slice()
      .sort((a, b) => a.bitrateKbps - b.bitrateKbps);

    if (!representations.length) {
      return null;
    }

    const safeKbps = Number.isFinite(preferredKbps) ? preferredKbps : this.estimator.getSafeKbps();

    if (!Number.isFinite(safeKbps)) {
      return representations[0];
    }

    return representations.filter(r => r.bitrateKbps <= safeKbps).at(-1) ?? representations[0];
  }

  makeManifest(videoId) {
    return { actionType: ACTION.FETCH_MANIFEST, videoId };
  }

  makeInit(videoId, representation) {
    return {
      actionType: ACTION.FETCH_INIT,
      videoId,
      mediaType: 'video',
      representationId: representation.id
    };
  }

  makeMedia(videoId, representation, segmentIndex) {
    return {
      actionType: ACTION.FETCH_MEDIA,
      videoId,
      mediaType: 'video',
      representationId: representation.id,
      segmentIndex
    };
  }

  makeAppend(videoId, representationId, segmentIndex) {
    return {
      actionType: ACTION.APPEND,
      videoId,
      resourceType: 'media',
      mediaType: 'video',
      representationId,
      segmentIndex
    };
  }
}

export function catalogVideo(context, videoId) {
  return context.getMediaCatalog().videos.find(video => video.videoId === videoId);
}

export function inFlight(context, match) {
  return context
    .getInFlightRequests()
    .some(request =>
      Object.entries(match).every(
        ([key, value]) => request.resource?.[key] === value || request[key] === value
      )
    );
}

export function cached(context, match) {
  return context
    .getCachedResources()
    .some(item => Object.entries(match).every(([key, value]) => item.resource[key] === value));
}

export function bufferedIndices(context, videoId) {
  const current = context.getCurrentVideo();
  return current.videoId === videoId
    ? [
        ...(current.playback.bufferedSegments ?? []),
        ...(current.playback.pendingAppendSegments ?? [])
      ]
    : [];
}
