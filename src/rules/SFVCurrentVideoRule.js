import { BaseSFVRule, bufferedIndices, cached, catalogVideo, inFlight } from './helpers.js';

export class SFVCurrentVideoRule extends BaseSFVRule {
  constructor() {
    super('SFVCurrentVideoRule');
  }

  reset(config = {}, seed = 1) {
    super.reset(config, seed);
    const target = config.activeBufferTargetSegments ?? 2;
    if (!Number.isInteger(target) || target < 1) {
      throw new Error('activeBufferTargetSegments must be a positive integer');
    }
  }

  getSwitchRequest(context) {
    const current = context.getCurrentVideo();
    const video = catalogVideo(context, current.videoId);
    const actions = [];

    if (!video || video.manifestState === 'UNKNOWN') {
      actions.push(this.makeManifest(current.videoId));
      return { rule: this.name, reason: 'load-active-manifest', actions };
    }

    if (video.manifestState !== 'AVAILABLE') {
      return { rule: this.name, reason: 'wait-active-manifest', actions };
    }

    const selectedRepresentation = this.selectRepresentation(video);
    if (!selectedRepresentation) {
      return { rule: this.name, reason: 'no-video-representation', actions };
    }

    const selectedInit = {
      videoId: video.videoId,
      resourceType: 'init',
      representationId: selectedRepresentation.id
    };
    if (!cached(context, selectedInit) && !inFlight(context, selectedInit)) {
      actions.push(this.makeInit(video.videoId, selectedRepresentation));
    }

    const buffered = new Set(bufferedIndices(context, video.videoId));
    const playheadS = current.playback.positionS ?? 0;
    const nextSegment = selectedRepresentation.segments.find(
      segment => segment.startS + segment.durationS > playheadS && !buffered.has(segment.index)
    );

    if (nextSegment) {
      const appendCandidate = context
        .getCachedResources({ videoId: video.videoId })
        .filter(
          item =>
            item.resource.resourceType === 'media' &&
            item.resource.segmentIndex === nextSegment.index
        )
        .sort((a, b) =>
          String(a.resource.representationId).localeCompare(String(b.resource.representationId))
        )
        .find(item =>
          cached(context, {
            videoId: video.videoId,
            resourceType: 'init',
            representationId: item.resource.representationId
          })
        );

      if (appendCandidate) {
        actions.push(
          this.makeAppend(
            video.videoId,
            appendCandidate.resource.representationId,
            nextSegment.index
          )
        );
      }
    }

    const targetCount = this.config.activeBufferTargetSegments ?? 2;
    const targetSegments = selectedRepresentation.segments
      .filter(segment => segment.startS + segment.durationS > playheadS)
      .slice(0, targetCount);

    for (const segment of targetSegments) {
      const logicalSegment = {
        videoId: video.videoId,
        resourceType: 'media',
        segmentIndex: segment.index
      };
      if (
        !buffered.has(segment.index) &&
        !cached(context, logicalSegment) &&
        !inFlight(context, logicalSegment)
      ) {
        actions.push(this.makeMedia(video.videoId, selectedRepresentation, segment.index));
      }
    }

    const safeKbps = this.estimator.getSafeKbps();
    return {
      rule: this.name,
      reason: `active-only safeThroughputKbps=${Math.round(safeKbps || 0)}`,
      actions
    };
  }
}
