import { SFVCurrentVideoRule } from './SFVCurrentVideoRule.js';
import { cached, catalogVideo, inFlight } from './helpers.js';

export class SFVMultiVideoPrefetchRule extends SFVCurrentVideoRule {
  constructor() {
    super();
    this.name = 'SFVMultiVideoPrefetchRule';
  }

  reset(config = {}, seed = 1) {
    super.reset(config, seed);
    const mps = config.max_preload_segments ?? config.maxPreloadSegments ?? 6;
    const pspv =
      config.preload_segments_per_video ?? config.preloadSegmentsPerVideo ?? 2;

    if (!Number.isInteger(mps) || mps < 0) {
      throw new Error('max_preload_segments must be a non-negative integer');
    }
    if (!Number.isInteger(pspv) || pspv < 0) {
      throw new Error('preload_segments_per_video must be a non-negative integer');
    }
  }

  getSwitchRequest(context) {
    const base = super.getSwitchRequest(context);
    const actions = [...base.actions];
    const playlist = context.getPlaylistState();
    const mps =
      this.config.max_preload_segments ?? this.config.maxPreloadSegments ?? 6;
    const pspv =
      this.config.preload_segments_per_video ??
      this.config.preloadSegmentsPerVideo ??
      2;

    if (
      mps <= 0 ||
      pspv <= 0 ||
      playlist.currentVideoIndex >= playlist.items.length - 1
    ) {
      return { rule: this.name, reason: 'prefetch-disabled-or-end', actions };
    }

    const futureItems = playlist.items.slice(playlist.currentVideoIndex + 1);
    const manifestLookahead = Math.min(
      futureItems.length,
      Math.max(1, Math.ceil(mps / pspv))
    );
    const candidates = futureItems.slice(0, manifestLookahead);

    for (const item of candidates) {
      const video = catalogVideo(context, item.videoId);
      if (
        video?.manifestState === 'UNKNOWN' &&
        !actions.some(
          (action) =>
            action.videoId === item.videoId && action.actionType === 'FETCH_MANIFEST'
        )
      ) {
        actions.push(this.makeManifest(item.videoId));
      }
    }

    let occupied = 0;
    for (const item of futureItems) {
      occupied += context
        .getCachedResources({ videoId: item.videoId })
        .filter((item) => item.resource.resourceType === 'media').length;
      occupied += context
        .getInFlightRequests()
        .filter(
          (request) =>
            request.resource?.videoId === item.videoId &&
            request.resource?.resourceType === 'media'
        ).length;
    }

    let remaining = Math.max(0, mps - occupied);
    for (const item of candidates) {
      if (remaining <= 0) {
        break;
      }

      const video = catalogVideo(context, item.videoId);
      if (!video || video.manifestState !== 'AVAILABLE') {
        continue;
      }

      const representation = this.selectRepresentation(video);
      if (!representation) {
        continue;
      }

      const initMatch = {
        videoId: video.videoId,
        resourceType: 'init',
        representationId: representation.id
      };
      if (
        !cached(context, initMatch) &&
        !inFlight(context, initMatch) &&
        !actions.some(
          (action) =>
            action.videoId === video.videoId && action.actionType === 'FETCH_INIT'
        )
      ) {
        actions.push(this.makeInit(video.videoId, representation));
      }

      let already =
        context
          .getCachedResources({ videoId: video.videoId })
          .filter((item) => item.resource.resourceType === 'media').length +
        context
          .getInFlightRequests()
          .filter(
            (request) =>
              request.resource?.videoId === video.videoId &&
              request.resource?.resourceType === 'media'
          ).length;

      for (const segment of representation.segments) {
        if (remaining <= 0 || already >= pspv) {
          break;
        }

        const logicalSegment = {
          videoId: video.videoId,
          resourceType: 'media',
          segmentIndex: segment.index
        };
        const alreadyScheduled = actions.some(
          (action) =>
            action.videoId === video.videoId &&
            action.actionType === 'FETCH_MEDIA' &&
            action.segmentIndex === segment.index
        );

        if (
          cached(context, logicalSegment) ||
          inFlight(context, logicalSegment) ||
          alreadyScheduled
        ) {
          continue;
        }

        actions.push(this.makeMedia(video.videoId, representation, segment.index));
        already += 1;
        remaining -= 1;
      }
    }

    return {
      rule: this.name,
      reason: `active+prefetch MPS=${mps} PSPV=${pspv}`,
      actions
    };
  }
}
