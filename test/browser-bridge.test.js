import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { listenFixtureServer } from '../scripts/fixture-server-lib.mjs';
import { SFVBrowserController } from '../src/dashjs/SFVBrowserController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import { SFVDashAssetResolver } from '../src/dashjs/SFVDashAssetResolver.js';
import { SFVBrowserMediaCatalog } from '../src/dashjs/SFVBrowserMediaCatalog.js';
import { SFVHttpTransport } from '../src/dashjs/SFVHttpTransport.js';
import { SFVBrowserRequestManager } from '../src/dashjs/SFVBrowserRequestManager.js';
import { SFVSegmentStore } from '../src/media/SFVSegmentStore.js';

const fixture = fs.readFileSync(
  new URL('../fixtures/dash/v1/manifest-video-only.mpd', import.meta.url),
  'utf8'
);
// Contract test double: converts the supplied real fixture to the normalized shape
// expected of dash.js DashParser, without pretending to test the real dash.js parser.
function mockDashParser(xml) {
  assert.match(xml, /SegmentTimeline/);
  if (/type="dynamic"/.test(xml)) return { type: 'dynamic' };
  const length = Number(xml.match(/mediaPresentationDuration="PT([\d.]+)S"/)?.[1]);
  const representations = [
    ...xml.matchAll(
      /<Representation id="(\d+)"[^>]*bandwidth="(\d+)"[^>]*width="(\d+)"[^>]*height="(\d+)"[^>]*>/g
    )
  ].map(([, id, bandwidth, width, height]) => ({
    id,
    bandwidth: Number(bandwidth),
    width: Number(width),
    height: Number(height),
    mimeType: 'video/mp4',
    codecs: 'avc1.42c00d',
    SegmentTemplate: {
      timescale: 15360,
      startNumber: 1,
      initialization: 'init-$RepresentationID$.m4s',
      media: 'chunk-$RepresentationID$-$Number%05d$.m4s',
      SegmentTimeline: { S: [{ t: 0, d: 30720, r: 2 }] }
    }
  }));
  assert.equal(representations.length, 3);
  return {
    type: 'static',
    mediaPresentationDuration: length,
    Period: [{ AdaptationSet: [{ contentType: 'video', Representation: representations }] }]
  };
}
function fakeVideo() {
  const listeners = new Map();
  const ranges = [];
  return {
    currentTime: 0,
    duration: 6,
    readyState: 3,
    paused: true,
    play: () => Promise.resolve(),
    buffered: {
      get length() {
        return ranges.length;
      },
      start: i => ranges[i][0],
      end: i => ranges[i][1]
    },
    addEventListener: (type, fn) => {
      const group = listeners.get(type) ?? new Set();
      group.add(fn);
      listeners.set(type, group);
    },
    removeEventListener: (type, fn) => listeners.get(type)?.delete(fn),
    fire: type => {
      for (const fn of listeners.get(type) ?? []) fn();
    },
    addRange: (start, end) => {
      ranges.push([start, end]);
    },
    clearRanges: () => ranges.splice(0)
  };
}
function fakeDashjs(videoElement, { appendDelayMs = 0, rejectAppend = false } = {}) {
  const traces = [];
  let generation = 0;
  return {
    traces,
    MediaPlayer: Object.assign(
      () => ({
        create() {
          const listeners = new Map();
          let manifest,
            settings,
            broken = false;
          const myGeneration = ++generation;
          return {
            updateSettings: s => {
              settings = s;
            },
            on: (name, fn) => listeners.set(name, fn),
            initialize: (element, mpd) => {
              assert.equal(element, videoElement);
              assert.equal(settings.streaming.scheduling.externallyControlled, true);
              manifest = mpd;
              queueMicrotask(() => {
                if (!broken) listeners.get('streamActivated')?.();
              });
            },
            getSFVPort: () => ({
              resolveInit: id => ({
                url: new URL(`init-${id}.m4s`, manifest.url).href,
                representationId: id,
                type: 'InitializationSegment',
                isInitializationRequest: () => true
              }),
              resolveMedia: (id, time) => {
                const index = Math.min(2, Math.floor(time / 2));
                return {
                  url: new URL(
                    `chunk-${id}-${String(index + 1).padStart(5, '0')}.m4s`,
                    manifest.url
                  ).href,
                  representationId: id,
                  type: 'MediaSegment',
                  index,
                  isInitializationRequest: () => false
                };
              },
              inject: async (request, payload) => {
                assert.ok(payload instanceof ArrayBuffer);
                traces.push({ type: 'inject-start', myGeneration, request });
                if (rejectAppend) throw new Error('deliberate mock SourceBuffer failure');
                if (appendDelayMs) await new Promise(resolve => setTimeout(resolve, appendDelayMs));
                if (broken) throw new Error('stale slot');
                if (!request.isInitializationRequest())
                  videoElement.addRange(request.index * 2, request.index * 2 + 2);
                traces.push({ type: 'buffer-confirmed', myGeneration, request });
              },
              finalize: index => traces.push({ type: 'finalize', index, myGeneration })
            }),
            reset: () => {
              broken = true;
              videoElement.clearRanges();
            }
          };
        }
      }),
      { events: { STREAM_ACTIVATED: 'streamActivated', ERROR: 'error' } }
    )
  };
}
async function until(check, { timeoutMs = 15000, diagnostics = () => '' } = {}) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (check()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail(`Timed out awaiting browser bridge condition. ${diagnostics()}`);
}
function playlist(origin) {
  return ['v1', 'v2', 'v3'].map(videoId => ({
    videoId,
    manifestUrl: `${origin}/media/${videoId}/manifest-video-only.mpd`
  }));
}

test('real video-only MPDs resolve exact init/media URLs; policy hides transport-only URLs', () => {
  const resolver = new SFVDashAssetResolver({ parseDashManifest: mockDashParser });
  const url = 'http://127.0.0.1:8080/media/v1/manifest-video-only.mpd';
  const parsed = resolver.parse('v1', new TextEncoder().encode(fixture), url);
  const catalog = new SFVBrowserMediaCatalog([{ videoId: 'v1', manifestUrl: url }]);
  catalog.registerParsedManifest('v1', parsed);
  assert.equal(
    catalog.getResourceDescriptor({
      videoId: 'v1',
      resourceType: 'media',
      representationId: '0',
      segmentIndex: 2
    }).url,
    'http://127.0.0.1:8080/media/v1/chunk-0-00003.m4s'
  );
  assert.equal(
    catalog.getResourceDescriptor({ videoId: 'v1', resourceType: 'init', representationId: '0' })
      .url,
    'http://127.0.0.1:8080/media/v1/init-0.m4s'
  );
  assert.ok(!JSON.stringify(catalog.getPolicyView()).includes('chunk-0-'));
  assert.ok(!JSON.stringify(catalog.getPolicyView()).includes('init-0.m4s'));
  assert.equal(catalog.getSegments('v1', 'video', '0').length, 3);
  assert.throws(
    () =>
      resolver.parse(
        'v1',
        new TextEncoder().encode(fixture.replace('type="static"', 'type="dynamic"')),
        url
      ),
    /static/
  );
});

test('HTTP request manager fetches the real fixture bytes and preserves transport observations', async t => {
  const srv = await listenFixtureServer();
  t.after(() => srv.close());
  const catalog = new SFVBrowserMediaCatalog(playlist(srv.origin));
  catalog.resolver = new SFVDashAssetResolver({ parseDashManifest: mockDashParser });
  const store = new SFVSegmentStore();
  const events = [];
  const manager = new SFVBrowserRequestManager({
    catalog,
    store,
    transport: new SFVHttpTransport(),
    now: () => 0.5,
    onEvent: e => events.push(e)
  });
  const videoId = 'v1';
  const manifestId = manager.dispatch({ actionType: 'FETCH_MANIFEST', videoId });
  await until(() => manager.get(manifestId).state === 'COMPLETED');
  const initId = manager.dispatch({
    actionType: 'FETCH_INIT',
    videoId,
    representationId: '0',
    mediaType: 'video'
  });
  const mediaId = manager.dispatch({
    actionType: 'FETCH_MEDIA',
    videoId,
    representationId: '0',
    mediaType: 'video',
    segmentIndex: 0
  });
  await until(
    () => manager.get(initId).state === 'COMPLETED' && manager.get(mediaId).state === 'COMPLETED'
  );
  assert.equal(
    manager.get(mediaId).finalBytesDelivered,
    store.get('v1|video|0|media|0').payload.byteLength
  );
  assert.ok(store.get('v1|video|0|init').payload.byteLength > 0);
  assert.ok(events.some(e => e.eventType === 'REQUEST_FIRST_BYTE'));
  assert.ok(
    events.every(e => e.time === 0.5),
    'transport monotonic times are converted to session clock'
  );
  manager.reset();
});

for (const [name, Rule, isPrefetch] of [
  ['B1', SFVCurrentVideoRule, false],
  ['B2', SFVMultiVideoPrefetchRule, true]
]) {
  test(`${name} uses unchanged shared rule and real HTTP fixture downloads with a mock dash.js append port`, async t => {
    const srv = await listenFixtureServer();
    t.after(() => srv.close());
    const video = fakeVideo();
    const dashjs = fakeDashjs(video, { appendDelayMs: 3 });
    const errors = [];
    const controller = new SFVBrowserController({
      dashjs,
      parseDashManifest: mockDashParser,
      videoElement: video,
      playlist: playlist(srv.origin),
      rule: new Rule(),
      config: {
        rule: {
          max_preload_segments: 2,
          preload_segments_per_video: 1,
          activeBufferTargetSegments: 2
        },
        scheduling: { swipeCancellation: true }
      },
      onError: e => errors.push(e)
    });
    t.after(() => controller.stop());
    controller.start();
    await until(() => controller.bridge.appended.size > 0, {
      diagnostics: () =>
        JSON.stringify({
          errors: errors.map(e => e.message),
          slot: !!controller.pool.slot?.port,
          pending: controller.abr.pending.length,
          decisions: controller.abr.decisionCount,
          events: controller.observations.events
            .slice(-12)
            .map(e => ({ type: e.eventType, error: e.error, reason: e.reason }))
        })
    });
    assert.equal(errors.length, 0, errors.map(e => e.stack).join('\n'));
    assert.ok(controller.observations.list().some(e => e.eventType === 'APPEND_STARTED'));
    assert.ok(controller.observations.list().some(e => e.eventType === 'RESOURCE_APPENDED'));
    const traces = dashjs.traces.filter(
      x => x.type === 'buffer-confirmed' && !x.request.isInitializationRequest()
    );
    assert.ok(traces.length > 0);
    const futureMedia = controller.requestManager
      .list()
      .filter(r => r.resource.resourceType === 'media' && r.resource.videoId !== 'v1');
    if (!isPrefetch) assert.equal(futureMedia.length, 0);
    else {
      await until(() =>
        controller.requestManager
          .list()
          .some(r => r.resource.resourceType === 'media' && r.resource.videoId === 'v2')
      );
      const all = controller.requestManager
        .list()
        .filter(r => r.resource.resourceType === 'media' && r.resource.videoId !== 'v1');
      assert.ok(all.length <= 2);
      assert.ok(all.filter(r => r.resource.videoId === 'v2').length <= 1);
      assert.ok(all.filter(r => r.resource.videoId === 'v3').length <= 1);
    }
    const result = controller.result();
    assert.ok(result.sessionRecord.session_summary.bytes_delivered > 0);
    assert.ok(result.events.every(e => Number.isFinite(e.time) && e.time >= 0));
    assert.equal(await controller.swipeNext(), true);
    await until(() => controller.pool.slot?.videoId === 'v2' && controller.pool.slot.port);
    assert.ok(!errors.length, errors.map(e => e.stack).join('\n'));
  });
}

test('autoplay blockage is reported and can be resumed by a user-triggered play request', async t => {
  const srv = await listenFixtureServer();
  t.after(() => srv.close());
  const video = fakeVideo();
  const blocked = [];
  const errors = [];
  video.play = () =>
    Promise.reject(Object.assign(new Error('User gesture required'), { name: 'NotAllowedError' }));
  const controller = new SFVBrowserController({
    dashjs: fakeDashjs(video),
    parseDashManifest: mockDashParser,
    videoElement: video,
    playlist: playlist(srv.origin),
    rule: new SFVCurrentVideoRule(),
    onAutoplayBlocked: id => blocked.push(id),
    onError: error => errors.push(error)
  });
  t.after(() => controller.stop());
  controller.start();
  await until(() => blocked.length > 0, {
    diagnostics: () =>
      JSON.stringify(
        controller.observations
          .list()
          .slice(-10)
          .map(e => e.eventType)
      )
  });
  assert.deepEqual(blocked, ['v1']);
  assert.equal(errors.length, 0);
  assert.ok(
    controller.observations
      .list()
      .some(e => e.eventType === 'PLAY_REQUEST_FAILED' && e.cause === 'automatic')
  );
  video.play = () => Promise.resolve();
  await controller.play({ cause: 'autoplay_unblock' });
  video.fire('playing');
  assert.ok(
    controller.observations
      .list()
      .some(e => e.eventType === 'PLAYBACK_STARTED' && e.videoId === 'v1')
  );
});

test('failed cached append is logged but cannot cause an unbounded retry decision loop', async t => {
  const srv = await listenFixtureServer();
  t.after(() => srv.close());
  const video = fakeVideo();
  const errors = [];
  const controller = new SFVBrowserController({
    dashjs: fakeDashjs(video, { rejectAppend: true }),
    parseDashManifest: mockDashParser,
    videoElement: video,
    playlist: playlist(srv.origin),
    rule: new SFVCurrentVideoRule(),
    onError: e => errors.push(e)
  });
  t.after(() => controller.stop());
  controller.start();
  await until(() => controller.observations.events.some(e => e.eventType === 'APPEND_FAILED'), {
    diagnostics: () => JSON.stringify(controller.observations.events.slice(-8))
  });
  await new Promise(resolve => setTimeout(resolve, 100));
  const before = controller.abr.decisionCount;
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(
    controller.abr.decisionCount,
    before,
    'an append failure must not reschedule itself indefinitely'
  );
  assert.ok(controller.bridge.failedAppends.size > 0);
  assert.ok(errors.some(e => /deliberate mock SourceBuffer failure/.test(e.message)));
});
