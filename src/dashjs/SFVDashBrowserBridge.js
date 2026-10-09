import { resourceKey } from '../media/resourceKey.js';
/** Executes SFV APPEND using the *normal* dash.js FragmentModel -> BufferController route. */
export class SFVDashBrowserBridge {
  constructor({
    catalog,
    store,
    pool,
    playback,
    onEvent = () => {},
    now = () => performance.now() / 1000
  }) {
    Object.assign(this, { catalog, store, pool, playback, onEvent, now });
    this.appended = new Set();
    this.appendPending = new Set();
    this.initialized = new Set();
    this.failedAppends = new Set();
    this.appendQueue = Promise.resolve();
  }
  async activate(videoId) {
    await this.pool.activate(videoId, this.catalog.getDashManifest(videoId));
    this.playback.activate(videoId);
    this.playback.ready = true;
    this.appended.clear();
    this.appendPending.clear();
    this.initialized.clear();
    this.failedAppends.clear();
    this.onEvent({
      time: this.now(),
      eventType: 'VIDEO_ACTIVATED',
      videoId,
      triggerDecision: true
    });
  }
  async appendCached(action) {
    const resource = { resourceType: 'media', mediaType: 'video', ...action };
    const key = resourceKey(resource);
    const item = this.store.get(key);
    if (!item?.payload) throw new Error(`Uncached fragment ${key}`);
    if (resource.videoId !== this.playback.videoId) throw new Error('APPEND to non-current video');
    // Repeating a permanently failed append with identical bytes cannot repair it.
    if (this.failedAppends.has(key))
      throw new Error(
        `APPEND previously failed for ${key}; restart the session after fixing the cause`
      );
    if (this.appended.has(key) || this.appendPending.has(key))
      throw new Error(`Duplicate APPEND: ${key}`);
    const init = {
      videoId: resource.videoId,
      mediaType: resource.mediaType,
      representationId: resource.representationId,
      resourceType: 'init'
    };
    const initKey = resourceKey(init);
    const initItem = this.store.get(initKey);
    if (!initItem?.payload) throw new Error(`Init resource unavailable: ${initKey}`);
    this.appendPending.add(key);
    const generation = this.pool.slot?.generation;
    // A single serialized MSE injection path prevents concurrent init/media appends.
    const pending = this.appendQueue
      .catch(() => {})
      .then(() =>
        this.#performAppend({
          resource,
          key,
          item,
          init,
          initKey,
          initItem,
          generation
        })
      );
    this.appendQueue = pending;
    return pending;
  }
  async #performAppend({ resource, key, item, init, initKey, initItem, generation }) {
    if (this.playback.videoId !== resource.videoId || this.pool.slot?.generation !== generation) {
      this.appendPending.delete(key);
      return;
    }
    this.onEvent({
      time: this.now(),
      eventType: 'APPEND_STARTED',
      resource,
      triggerDecision: false
    });
    try {
      if (!this.initialized.has(initKey)) {
        await this.pool.inject(init, initItem.payload);
        this.initialized.add(initKey);
        this.onEvent({
          time: this.now(),
          eventType: 'INIT_APPENDED',
          resource: init,
          triggerDecision: false
        });
      }
      await this.pool.inject(item.resource, item.payload);
      this.appended.add(key);
      this.playback.append(item.resource);
      this.#completeVideoBufferIfLast(resource);
      this.onEvent({
        time: this.now(),
        eventType: 'RESOURCE_APPENDED',
        videoId: resource.videoId,
        segmentIndex: resource.segmentIndex,
        representationId: resource.representationId,
        resource: item.resource,
        triggerDecision: true
      });
    } catch (error) {
      if (error.code === 'SFV_SLOT_REPLACED') {
        this.onEvent({
          time: this.now(),
          eventType: 'APPEND_CANCELLED',
          resource,
          triggerDecision: false
        });
        return;
      }
      this.failedAppends.add(key);
      this.onEvent({
        time: this.now(),
        eventType: 'APPEND_FAILED',
        resource,
        error: error.message,
        triggerDecision: false
      });
      throw error;
    } finally {
      this.appendPending.delete(key);
    }
  }
  #completeVideoBufferIfLast(resource) {
    const video = this.catalog.dataset.videos.find(v => v.videoId === resource.videoId);
    const segments = video?.representations?.video?.[0]?.segments ?? [];
    if (segments.length && resource.segmentIndex === segments.at(-1).index) {
      this.pool.finalize(resource.segmentIndex);
    }
  }
  reset() {
    this.pool.reset();
    this.appendQueue = Promise.resolve();
    this.appended.clear();
    this.appendPending.clear();
    this.initialized.clear();
    this.failedAppends.clear();
  }
}
