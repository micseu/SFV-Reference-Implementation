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

  /**
   * L1 static plan-rate cap in kbps derived from `cspFields.plan_downlink_mbps`,
   * or NaN when no positive plan rate is available (L0 or absent field).
   */
  getPlanCapKbps(context = null) {
    const planMbps = context?.getCspFields?.()?.plan_downlink_mbps;
    if (!(Number.isFinite(planMbps) && planMbps > 0)) {
      return Number.NaN;
    }
    const planSafety = Number.isFinite(this.config.planSafetyFactor)
      ? this.config.planSafetyFactor
      : (this.estimator.config?.safetyFactor ?? 0.9);
    return planMbps * 1000 * planSafety;
  }

  /**
   * Picks the highest video representation not exceeding the safe throughput.
   * When `context` carries a CSP plan rate, the safe throughput is additionally
   * capped at `plan_downlink_mbps * 1000 * safetyFactor` (never raised by it,
   * except on cold start when `config.usePlanOnColdStart === true`).
   */
  selectRepresentation(video, preferredKbps = Number.NaN, context = null) {
    const representations = (video.representations?.video ?? [])
      .slice()
      .sort((a, b) => a.bitrateKbps - b.bitrateKbps);

    if (!representations.length) {
      return null;
    }

    const planCapKbps = this.getPlanCapKbps(context);
    let safeKbps = Number.isFinite(preferredKbps) ? preferredKbps : this.estimator.getSafeKbps();

    if (Number.isFinite(planCapKbps)) {
      if (Number.isFinite(safeKbps)) {
        safeKbps = Math.min(safeKbps, planCapKbps);
      } else if (this.config.usePlanOnColdStart === true) {
        safeKbps = planCapKbps;
      }
    }

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
