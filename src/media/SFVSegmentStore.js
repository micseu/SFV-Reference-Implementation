import { resourceKey } from './resourceKey.js';

/** Shared logical cache. Admission happens AFTER a completed transfer; no ABR or request policy. */
export class SFVSegmentStore {
  constructor({ maxBytes = Infinity } = {}) {
    if (maxBytes !== Infinity && (!Number.isSafeInteger(maxBytes) || maxBytes < 0)) {
      throw new TypeError('cache.maxBytes must be a non-negative safe integer or Infinity');
    }
    this.maxBytes = maxBytes;
    this.usedBytes = 0;
    this.items = new Map();
  }
  getUsedBytes() {
    return this.usedBytes;
  }
  getAvailableBytes() {
    return this.maxBytes === Infinity ? Infinity : this.maxBytes - this.usedBytes;
  }
  getMaxBytes() {
    return this.maxBytes;
  }
  /** Original put() contract: return the resource key on success, null if capacity is exhausted. */
  put(resource, payload = null, metadata = {}) {
    const result = this.putDetailed(resource, payload, metadata);
    return result.admitted ? result.key : null;
  }
  putDetailed(resource, payload = null, metadata = {}) {
    const key = resourceKey(resource);
    const bytes = payload?.byteLength ?? metadata.bytes ?? resource.bytesTotal;
    if (!Number.isFinite(bytes) || bytes < 0)
      throw new TypeError(`Missing or invalid byte size for ${key}`);
    const old = this.items.get(key);
    const projected = this.usedBytes - (old?.bytes ?? 0) + bytes;
    if (projected > this.maxBytes) {
      return {
        admitted: false,
        key,
        reason: 'CAPACITY_EXCEEDED',
        bytes,
        usedBytes: this.usedBytes,
        maxBytes: this.maxBytes
      };
    }
    this.items.set(key, {
      resource: structuredClone(resource),
      payload,
      metadata: structuredClone(metadata),
      bytes
    });
    this.usedBytes = projected;
    return { admitted: true, key, bytes, usedBytes: this.usedBytes, maxBytes: this.maxBytes };
  }
  has(resource) {
    return this.items.has(typeof resource === 'string' ? resource : resourceKey(resource));
  }
  get(resource) {
    return this.items.get(typeof resource === 'string' ? resource : resourceKey(resource)) ?? null;
  }
  remove(resource) {
    const key = typeof resource === 'string' ? resource : resourceKey(resource);
    const item = this.items.get(key);
    if (!item) return null;
    this.items.delete(key);
    this.usedBytes -= item.bytes;
    return { key, resource: structuredClone(item.resource), bytes: item.bytes };
  }
  /** Call only at a verified lifecycle boundary; never evicts useful items for new data. */
  removeWhere(predicate) {
    const removed = [];
    for (const [key, item] of this.items) {
      if (predicate(item.resource, item.metadata, key)) removed.push(this.remove(key));
    }
    return removed;
  }
  list(filter = {}) {
    return [...this.items.values()]
      .filter(x => Object.entries(filter).every(([k, v]) => x.resource[k] === v))
      .map(x => ({ resource: structuredClone(x.resource), metadata: structuredClone(x.metadata) }));
  }
  stats() {
    return {
      usedBytes: this.usedBytes,
      maxBytes: Number.isFinite(this.maxBytes) ? this.maxBytes : null,
      entries: this.items.size
    };
  }
}
