import { ACTION, MANIFEST_STATE } from './constants.js';
import { resourceKey } from '../media/resourceKey.js';
export class SFVActionValidator {
  validate(actions, runtime) {
    if (!Array.isArray(actions)) throw new Error('actions must be an array');
    const seen = new Set();
    for (const a of actions) {
      if (!Object.values(ACTION).includes(a.actionType))
        throw new Error(`Unknown action ${a.actionType}`);
      if (a.actionType === ACTION.ABORT) {
        if (
          !runtime.requests.some(
            r => r.requestId === a.requestId && ['QUEUED', 'ACTIVE'].includes(r.state)
          )
        )
          throw new Error(`Cannot abort ${a.requestId}`);
        continue;
      }
      if (a.actionType === ACTION.APPEND) {
        const key = resourceKey({ resourceType: a.resourceType ?? 'media', ...a });
        if (!runtime.store.some(x => resourceKey(x.resource) === key))
          throw new Error(`Cannot append uncached ${key}`);
        continue;
      }
      if (a.actionType === ACTION.FETCH_MANIFEST) {
        if (runtime.catalogState(a.videoId) !== MANIFEST_STATE.UNKNOWN)
          throw new Error(`Manifest not fetchable ${a.videoId}`);
      } else {
        if (runtime.catalogState(a.videoId) !== MANIFEST_STATE.AVAILABLE)
          throw new Error(`Manifest unavailable ${a.videoId}`);
      }
      const key = resourceKey({
        resourceType:
          a.actionType === ACTION.FETCH_INIT
            ? 'init'
            : a.actionType === ACTION.FETCH_MEDIA
              ? 'media'
              : 'manifest',
        ...a
      });
      if (seen.has(key)) throw new Error(`Duplicate action ${key}`);
      seen.add(key);
      if (runtime.store.some(x => resourceKey(x.resource) === key))
        throw new Error(`Already cached ${key}`);
      if (
        runtime.requests.some(
          r =>
            ['QUEUED', 'ACTIVE', 'CANCELLING'].includes(r.state) && resourceKey(r.resource) === key
        )
      )
        throw new Error(`Already in flight ${key}`);
    }
    return actions;
  }
}
