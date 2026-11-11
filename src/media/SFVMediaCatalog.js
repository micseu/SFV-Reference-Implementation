import { MANIFEST_STATE } from '../core/constants.js';

export class SFVMediaCatalog {
  constructor(dataset) {
    this.dataset = structuredClone(dataset);
    this.states = new Map(dataset.videos.map(v => [v.videoId, MANIFEST_STATE.UNKNOWN]));
  }
  getPlaylist() {
    return this.dataset.videos.map(({ videoId, manifestUrl }) => ({ videoId, manifestUrl }));
  }
  getManifestState(videoId) {
    return this.states.get(videoId) ?? null;
  }
  markManifestLoading(videoId) {
    this.#assertVideo(videoId);
    this.states.set(videoId, MANIFEST_STATE.LOADING);
  }
  markManifestAvailable(videoId) {
    this.#assertVideo(videoId);
    this.states.set(videoId, MANIFEST_STATE.AVAILABLE);
  }
  markManifestFailed(videoId) {
    this.#assertVideo(videoId);
    this.states.set(videoId, MANIFEST_STATE.FAILED);
  }
  getVideo(videoId) {
    this.#assertAvailable(videoId);
    const v = this.#video(videoId);
    return { videoId: v.videoId, durationS: v.durationS, segmentDurationS: v.segmentDurationS };
  }
  getRepresentations(videoId, mediaType = 'video') {
    this.#assertAvailable(videoId);
    const reps = this.#video(videoId).representations[mediaType] ?? [];
    return reps.map(({ id, bitrateKbps, width, height, codec, frameRateFps }) => ({
      id,
      bitrateKbps,
      width,
      height,
      codec,
      frameRateFps
    }));
  }
  getSegments(videoId, mediaType = 'video', representationId) {
    this.#assertAvailable(videoId);
    const rep = this.#rep(videoId, mediaType, representationId);
    return rep.segments.map(({ index, startS, durationS }) => ({ index, startS, durationS }));
  }
  getResourceDescriptor({
    videoId,
    resourceType,
    mediaType = 'video',
    representationId,
    segmentIndex
  }) {
    const v = this.#video(videoId);
    if (resourceType === 'manifest')
      return { videoId, resourceType, url: v.manifestUrl, bytesTotal: v.manifestBytes };
    this.#assertAvailable(videoId);
    const rep = this.#rep(videoId, mediaType, representationId);
    if (resourceType === 'init')
      return {
        videoId,
        resourceType,
        mediaType,
        representationId,
        url: rep.initUrl,
        bytesTotal: rep.initBytes
      };
    const seg = rep.segments.find(s => s.index === segmentIndex);
    if (!seg) throw new Error(`Unknown segment ${videoId}/${representationId}/${segmentIndex}`);
    return {
      videoId,
      resourceType: 'media',
      mediaType,
      representationId,
      segmentIndex,
      startS: seg.startS,
      durationS: seg.durationS,
      url: seg.url,
      bytesTotal: seg.bytes
    };
  }
  getPolicyView() {
    const videos = this.dataset.videos.map(v => {
      const state = this.getManifestState(v.videoId);
      const base = { videoId: v.videoId, manifestUrl: v.manifestUrl, manifestState: state };
      if (state !== MANIFEST_STATE.AVAILABLE) return base;
      return {
        ...base,
        durationS: v.durationS,
        segmentDurationS: v.segmentDurationS,
        representations: Object.fromEntries(
          Object.entries(v.representations).map(([type, reps]) => [
            type,
            reps.map(r => ({
              id: r.id,
              bitrateKbps: r.bitrateKbps,
              width: r.width,
              height: r.height,
              codec: r.codec,
              frameRateFps: r.frameRateFps,
              segments: r.segments.map(s => ({
                index: s.index,
                startS: s.startS,
                durationS: s.durationS
              }))
            }))
          ])
        )
      };
    });
    return structuredClone({ videos });
  }
  #video(videoId) {
    const v = this.dataset.videos.find(v => v.videoId === videoId);
    if (!v) throw new Error(`Unknown video ${videoId}`);
    return v;
  }
  #rep(videoId, type, id) {
    const r = (this.#video(videoId).representations[type] ?? []).find(r => r.id === id);
    if (!r) throw new Error(`Unknown representation ${videoId}/${type}/${id}`);
    return r;
  }
  #assertVideo(videoId) {
    this.#video(videoId);
  }
  #assertAvailable(videoId) {
    if (this.getManifestState(videoId) !== MANIFEST_STATE.AVAILABLE)
      throw new Error(`Manifest not available for ${videoId}`);
  }
}
