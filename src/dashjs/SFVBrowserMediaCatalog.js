import { SFVMediaCatalog } from '../media/SFVMediaCatalog.js';

/** Adds discovered MPD metadata to the existing simulator-compatible catalog. */
export class SFVBrowserMediaCatalog extends SFVMediaCatalog {
  constructor(playlist) {
    super({videos: playlist.map(item => ({videoId:item.videoId,manifestUrl:item.manifestUrl,
      representations:{video:[],audio:[]}}))});
    if (new Set(playlist.map(v => v.videoId)).size !== playlist.length || !playlist.length) {
      throw new Error('Playlist must be nonempty and contain unique videoIds');
    }
    this.dashManifests = new Map();
  }
  registerParsedManifest(videoId, {video, dashManifest}) {
    const target = this.dataset.videos.find(v => v.videoId === videoId);
    if (!target) throw new Error(`Unknown video ${videoId}`);
    if (target.manifestUrl !== video.manifestUrl) throw new Error('Manifest URL mismatch');
    Object.assign(target,video);
    this.dashManifests.set(videoId,dashManifest);
    this.markManifestAvailable(videoId);
  }
  getDashManifest(videoId) { return this.dashManifests.get(videoId) ?? null; }
  // Never reveal URLs/exact sizes through getPolicyView inherited from SFVMediaCatalog.
}
