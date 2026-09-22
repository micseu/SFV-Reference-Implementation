import { normalizeSchedulingConfig } from '../core/SFVConfig.js';

/**
 * Thin orchestration shell for a patched dash.js checkout.
 * `bridge` deliberately hides dash.js internals from SFV policy code.
 */
export class SFVReferenceRuntime {
  constructor({ bridge, rule }) {
    this.bridge = bridge;
    this.rule = rule;
  }

  async initialize(config = {}) {
    const scheduling = normalizeSchedulingConfig(config.scheduling);
    this.config = { ...config, scheduling };
    await this.bridge.initialize({
      externallyControlled: true,
      swipeCancellation: scheduling.swipeCancellation
    });
    this.rule.reset(config.rule ?? {}, config.seed ?? 1);
  }

  async fetchManifest(video) {
    const bytes = await this.bridge.fetchManifest(video.manifestUrl);
    return this.bridge.parseManifest(video.videoId, bytes);
  }

  async fetchAndCache(resource) {
    return this.bridge.fetchAndCache(resource);
  }

  async appendCached(resourceKey) {
    return this.bridge.appendCached(resourceKey);
  }

  async swipeNext() {
    return this.bridge.swipeNext({
      cancelOutstandingRequests: this.config.scheduling.swipeCancellation
    });
  }
}
