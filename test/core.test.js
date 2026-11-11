import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVMediaCatalog } from '../src/media/SFVMediaCatalog.js';
import { SFVRulesContext } from '../src/core/SFVRulesContext.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);
function ctx(catalog, { current = 0, cache = [], requests = [] } = {}) {
  const p = catalog.getPlaylist();
  return new SFVRulesContext({
    time: 0,
    session: { sessionId: 's' },
    playlist: p,
    currentVideoIndex: current,
    catalog: catalog.getPolicyView(),
    store: cache,
    requests,
    playback: { videoId: p[current].videoId, positionS: 0, bufferedSegments: [], bufferRanges: [] },
    networkHistory: [],
    userHistory: [],
    playbackHistory: []
  });
}
test('policy view hides exact resource sizes', () => {
  const c = new SFVMediaCatalog(dataset);
  c.markManifestAvailable('v1');
  const s = JSON.stringify(c.getPolicyView());
  assert.equal(s.includes('bytes'), false);
  assert.equal(s.includes('bytesTotal'), false);
});
test('B1 only requests active video', () => {
  const c = new SFVMediaCatalog(dataset);
  c.markManifestAvailable('v1');
  const r = new SFVCurrentVideoRule();
  r.reset({}, 1);
  const out = r.getSwitchRequest(ctx(c));
  assert.ok(out.actions.length > 0);
  assert.ok(out.actions.every(a => a.videoId === 'v1'));
});
test('B2 obeys MPS and PSPV for future media', () => {
  const c = new SFVMediaCatalog(dataset);
  for (const v of ['v1', 'v2', 'v3']) c.markManifestAvailable(v);
  const r = new SFVMultiVideoPrefetchRule();
  r.reset({ max_preload_segments: 3, preload_segments_per_video: 2 }, 1);
  const out = r.getSwitchRequest(ctx(c));
  const fut = out.actions.filter(a => a.actionType === 'FETCH_MEDIA' && a.videoId !== 'v1');
  assert.equal(fut.length, 3);
  assert.ok(fut.filter(a => a.videoId === 'v2').length <= 2);
  assert.ok(fut.filter(a => a.videoId === 'v3').length <= 2);
});

test('B2 limits manifest lookahead to the MPS/PSPV horizon', () => {
  const c = new SFVMediaCatalog(dataset);
  c.markManifestAvailable('v1');
  const r = new SFVMultiVideoPrefetchRule();
  r.reset({ max_preload_segments: 1, preload_segments_per_video: 1 }, 1);
  const out = r.getSwitchRequest(ctx(c));
  const manifests = out.actions.filter(a => a.actionType === 'FETCH_MANIFEST');
  assert.deepEqual(
    manifests.map(a => a.videoId),
    ['v2']
  );
});

test('baseline rules do not own swipe cancellation', () => {
  const c = new SFVMediaCatalog(dataset);
  c.markManifestAvailable('v2');
  const r = new SFVCurrentVideoRule();
  r.reset({}, 1);
  const requests = [
    {
      requestId: 'old-r',
      state: 'ACTIVE',
      resource: { videoId: 'v1', resourceType: 'media', representationId: '0', segmentIndex: 0 }
    }
  ];
  const out = r.getSwitchRequest(ctx(c, { current: 1, requests }));
  assert.equal(
    out.actions.some(action => action.actionType === 'ABORT'),
    false
  );
});

test('cancelled transfers are not throughput samples', () => {
  const c = new SFVMediaCatalog(dataset);
  c.markManifestAvailable('v1');
  const context = ctx(c);
  const r = new SFVCurrentVideoRule();
  r.reset({}, 1);
  r.onObservationBatch(
    [
      {
        eventType: 'REQUEST_CANCELLED',
        request: {
          requestId: 'cancelled-1',
          resource: { resourceType: 'media', videoId: 'v1' },
          firstByteTime: 0.1,
          endTime: 0.5,
          finalBytesDelivered: 100000
        }
      }
    ],
    context
  );
  assert.equal(r.getState().estimator.state.samples.length, 0);
});

test('B2 rejects invalid negative prefetch budgets', () => {
  const r = new SFVMultiVideoPrefetchRule();
  assert.throws(() => r.reset({ max_preload_segments: -1, preload_segments_per_video: 1 }, 1));
  assert.throws(() => r.reset({ max_preload_segments: 1, preload_segments_per_video: -1 }, 1));
});

test('rule state snapshot/restore preserves deterministic next decision', () => {
  const c = new SFVMediaCatalog(dataset);
  c.markManifestAvailable('v1');
  const context = ctx(c);
  const completed = {
    eventType: 'REQUEST_COMPLETED',
    request: {
      requestId: 'sample-1',
      resource: { resourceType: 'media', videoId: 'v1' },
      firstByteTime: 0.1,
      endTime: 1.1,
      finalBytesDelivered: 250000
    }
  };
  const first = new SFVCurrentVideoRule();
  first.reset({}, 123);
  first.onObservationBatch([completed], context);
  const snapshot = first.getState();
  const expected = first.getSwitchRequest(context);
  const restored = new SFVCurrentVideoRule();
  restored.reset({}, 999);
  restored.setState(snapshot);
  assert.deepEqual(restored.getState(), snapshot);
  assert.deepEqual(restored.getSwitchRequest(context), expected);
});
