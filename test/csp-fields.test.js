import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCspFields } from '../src/core/SFVCspFields.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import { SFVNetworkStepHarness } from '../src/cosim/SFVNetworkStepHarness.js';

test('normalizeCspFields accepts pilot-shaped snapshot', () => {
  const fields = normalizeCspFields({
    updated_at_s: 0.01,
    plan_downlink_mbps: 10,
    achieved_throughput_mbps: null,
    rtt_ms: 40,
    loss_rate: 0,
    congestion_rate: null
  });
  assert.equal(fields.plan_downlink_mbps, 10);
  assert.equal(fields.achieved_throughput_mbps, null);
});

test('applyCspUpdate exposes fields on rules context without re-deciding', () => {
  const dataset = {
    videos: [
      {
        videoId: 'v1',
        representations: {
          video: [{ id: 'r0', bitrateKbps: 500, segments: [{ index: 0, startS: 0, durationS: 5 }] }]
        }
      }
    ]
  };
  const controller = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: { sessionStartTimeS: 0, sessionEndTimeS: 6, swipeTimesS: [] }
  });
  controller.startAt(0);
  controller.applyCspUpdate({ updated_at_s: 0, plan_downlink_mbps: 8 }, 0);
  assert.equal(controller.getCspFields()?.plan_downlink_mbps, 8);
});

// ---------------------------------------------------------------------------
// L1 static plan-rate capping (cspFields.plan_downlink_mbps)
// ---------------------------------------------------------------------------

const LADDER_KBPS = [300, 650, 1300, 2400, 5200];
const SAFETY = 0.9;

function makeVideo(videoId, { segmentBytes = 150000, segmentCount = 6 } = {}) {
  return {
    videoId,
    manifestState: 'AVAILABLE',
    manifestBytes: 2000,
    segmentDurationS: 2,
    durationS: segmentCount * 2,
    representations: {
      video: LADDER_KBPS.map(kbps => ({
        id: `r${kbps}`,
        bitrateKbps: kbps,
        initBytes: 800,
        segments: Array.from({ length: segmentCount }, (_, index) => ({
          index,
          startS: index * 2,
          durationS: 2,
          bytes: segmentBytes
        }))
      }))
    }
  };
}

function makeContext({ cspFields = null, videos = [makeVideo('v1'), makeVideo('v2')] } = {}) {
  return {
    getCspFields: () => (cspFields == null ? null : structuredClone(cspFields)),
    getCurrentVideo: () => ({ videoId: 'v1', playback: { positionS: 0 } }),
    getMediaCatalog: () => ({ videos }),
    getPlaylistState: () => ({
      currentVideoIndex: 0,
      items: videos.map(video => ({ videoId: video.videoId }))
    }),
    getCachedResources: () => [],
    getInFlightRequests: () => []
  };
}

/** Feeds one completed media download whose realized throughput equals `throughputKbps`. */
function feedThroughput(rule, throughputKbps) {
  const durationS = 0.4;
  rule.onObservationBatch([
    {
      eventType: 'REQUEST_COMPLETED',
      request: {
        requestId: 'sample-0',
        resource: { resourceType: 'media' },
        firstByteTime: 1,
        endTime: 1 + durationS,
        finalBytesDelivered: Math.round((throughputKbps * 1000 * durationS) / 8)
      }
    }
  ]);
}

function createRule(Rule, config = {}) {
  const rule = new Rule();
  rule.reset(config, 1);
  return rule;
}

/** Highest bitrate among the media/init actions targeting `videoId`. */
function selectedKbps(request, videoId) {
  const ids = request.actions
    .filter(action => action.videoId === videoId && action.representationId)
    .map(action => Number(action.representationId.slice(1)));
  assert.ok(ids.length > 0, `expected actions for ${videoId}`);
  assert.equal(new Set(ids).size, 1, 'one representation per video expected');
  return ids[0];
}

const RULES = [
  { name: 'SFVCurrentVideoRule', Rule: SFVCurrentVideoRule, videoId: 'v1' },
  { name: 'SFVMultiVideoPrefetchRule', Rule: SFVMultiVideoPrefetchRule, videoId: 'v1' }
];

for (const { name, Rule } of RULES) {
  test(`${name} L0 (no CSP fields) selects high rungs on high throughput`, () => {
    for (const cspFields of [null, { plan_downlink_mbps: null }]) {
      const rule = createRule(Rule);
      feedThroughput(rule, 4000);
      assert.equal(selectedKbps(rule.getSwitchRequest(makeContext({ cspFields })), 'v1'), 2400);

      const fast = createRule(Rule);
      feedThroughput(fast, 10000);
      assert.equal(selectedKbps(fast.getSwitchRequest(makeContext({ cspFields })), 'v1'), 5200);
    }
  });

  test(`${name} L1 caps a 6 Mbps burst at plan_downlink_mbps * 1000 * safetyFactor`, () => {
    for (const planMbps of [2.0, 2.5]) {
      const rule = createRule(Rule);
      feedThroughput(rule, 6000);
      const ctx = makeContext({ cspFields: { plan_downlink_mbps: planMbps } });
      const kbps = selectedKbps(rule.getSwitchRequest(ctx), 'v1');
      assert.ok(kbps <= planMbps * 1000 * SAFETY);
      assert.equal(kbps, 1300);
    }
  });

  test(`${name} L1 still adapts downward when throughput is below the plan cap`, () => {
    const rule = createRule(Rule);
    feedThroughput(rule, 1000);
    const ctx = makeContext({ cspFields: { plan_downlink_mbps: 2.5 } });
    assert.equal(selectedKbps(rule.getSwitchRequest(ctx), 'v1'), 650);
  });

  test(`${name} L1 honours a custom planSafetyFactor`, () => {
    const rule = createRule(Rule, { planSafetyFactor: 0.5 });
    feedThroughput(rule, 10000);
    const ctx = makeContext({ cspFields: { plan_downlink_mbps: 2.5 } });
    // 2500 * 0.5 = 1250 kbps -> 650 kbps rung.
    assert.equal(selectedKbps(rule.getSwitchRequest(ctx), 'v1'), 650);
  });

  test(`${name} L1 cold start stays conservative unless usePlanOnColdStart is enabled`, () => {
    const ctx = makeContext({ cspFields: { plan_downlink_mbps: 2.5 } });
    assert.equal(selectedKbps(createRule(Rule).getSwitchRequest(ctx), 'v1'), 300);
    assert.equal(
      selectedKbps(createRule(Rule, { usePlanOnColdStart: false }).getSwitchRequest(ctx), 'v1'),
      300
    );
    // 2500 * 0.9 = 2250 kbps -> 1300 kbps rung.
    const warm = createRule(Rule, { usePlanOnColdStart: true });
    assert.equal(selectedKbps(warm.getSwitchRequest(ctx), 'v1'), 1300);
  });

  test(`${name} ignores non-positive plan_downlink_mbps`, () => {
    for (const plan of [0, -1]) {
      const rule = createRule(Rule, { usePlanOnColdStart: true });
      feedThroughput(rule, 10000);
      const ctx = makeContext({ cspFields: { plan_downlink_mbps: plan } });
      assert.equal(selectedKbps(rule.getSwitchRequest(ctx), 'v1'), 5200);
    }
  });
}

test('SFVMultiVideoPrefetchRule applies the plan cap to prefetched videos', () => {
  const rule = createRule(SFVMultiVideoPrefetchRule);
  feedThroughput(rule, 6000);
  const l0 = rule.getSwitchRequest(makeContext());
  assert.equal(selectedKbps(l0, 'v2'), 5200);
  const l1 = rule.getSwitchRequest(makeContext({ cspFields: { plan_downlink_mbps: 2.0 } }));
  assert.equal(selectedKbps(l1, 'v2'), 1300);
  const below = createRule(SFVMultiVideoPrefetchRule);
  feedThroughput(below, 1000);
  const lowReq = below.getSwitchRequest(makeContext({ cspFields: { plan_downlink_mbps: 2.5 } }));
  assert.equal(selectedKbps(lowReq, 'v2'), 650);
});

test('BaseSFVRule.selectRepresentation is backward compatible without context', () => {
  const rule = createRule(SFVCurrentVideoRule);
  const video = makeVideo('v1');
  assert.equal(rule.selectRepresentation(video).bitrateKbps, 300);
  assert.equal(rule.selectRepresentation(video, 3000).bitrateKbps, 2400);
  assert.equal(rule.selectRepresentation({ representations: { video: [] } }), null);
  const ctx = makeContext({ cspFields: { plan_downlink_mbps: 2.0 } });
  assert.equal(rule.selectRepresentation(video, 6000, ctx).bitrateKbps, 1300);
});

test('SFVCurrentVideoRule reason reports the plan cap only when plan_downlink_mbps is active', () => {
  const rule = createRule(SFVCurrentVideoRule);
  feedThroughput(rule, 6000);
  assert.equal(rule.getSwitchRequest(makeContext()).reason, 'active-only safeThroughputKbps=5400');
  assert.equal(
    rule.getSwitchRequest(makeContext({ cspFields: { plan_downlink_mbps: null } })).reason,
    'active-only safeThroughputKbps=5400'
  );
  assert.equal(
    rule.getSwitchRequest(makeContext({ cspFields: { plan_downlink_mbps: 2.0 } })).reason,
    'active-only safeThroughputKbps=5400 planCapKbps=1800'
  );
});

// --- Co-simulation: SFVNetworkStepHarness with collaboration.csp_by_ue --------

const BURST_KBPS = 6000;
const SEGMENT_BYTES = 150000;

/**
 * Drives one UE through a 6 Mbps burst (cold-start segments complete in 200 ms each) and
 * returns the representation bitrates (kbps) of every media request submitted afterwards.
 */
function runBurstScenario({ behavior, planMbps }) {
  const dataset = { videos: [makeVideo('v1', { segmentBytes: SEGMENT_BYTES, segmentCount: 6 })] };
  if (behavior === 'preload') dataset.videos.push(makeVideo('v2', { segmentBytes: SEGMENT_BYTES }));
  const harness = new SFVNetworkStepHarness({
    dataset,
    sessions: [
      {
        ue_id: 0,
        player_behavior: behavior,
        config: { sessionStartTimeS: 0, sessionEndTimeS: 12, swipeTimesS: [] }
      }
    ],
    duration_s: 12,
    network_backend: 'test'
  });
  const transport = harness.states.get(0).transport;
  const collaboration =
    planMbps === undefined
      ? undefined
      : { csp_by_ue: { 0: { updated_at_s: 0, plan_downlink_mbps: planMbps } } };
  const stepExtra = collaboration ? { collaboration } : {};
  const mediaKbps = reply =>
    reply.actions
      .filter(action => action.op === 'submit_request')
      .map(action => transport.get(action.request_id))
      .filter(entry => entry.resource.resourceType === 'media')
      .map(entry => Number(entry.resource.representationId.slice(1)));

  const outstanding = [];
  const coldStart = [];
  const afterBurst = [];
  let burstDelivered = false;
  const collect = reply => {
    outstanding.push(...reply.actions.filter(action => action.op === 'submit_request'));
    (burstDelivered ? afterBurst : coldStart).push(...mediaKbps(reply));
  };
  const step = (time_s, events) =>
    collect(harness.onStep({ time_s, events, is_final: false, ...stepExtra }));

  step(0, []);

  // Deliver every outstanding request as one burst at BURST_KBPS: first byte at `t`,
  // completion `dtS` later, so each media sample realizes exactly BURST_KBPS.
  const dtS = (8 * SEGMENT_BYTES) / (BURST_KBPS * 1000);
  for (let t = 0.5; t + dtS + 0.5 < 12; t += 1) {
    const batch = outstanding.splice(0);
    step(
      t,
      batch.map(action => ({
        event_type: 'DownloadProgress',
        ue_id: 0,
        request_id: action.request_id,
        bytes_delivered: 1,
        time_s: t
      }))
    );
    // Media completions feed the throughput estimator; later requests are "after the burst".
    const carriesMedia = batch.some(
      action => transport.get(action.request_id).resource.resourceType === 'media'
    );
    burstDelivered ||= carriesMedia;
    step(
      t + dtS,
      batch.map(action => ({
        event_type: 'DownloadCompleted',
        ue_id: 0,
        request_id: action.request_id,
        time_s: t + dtS
      }))
    );
  }
  return { coldStart, afterBurst };
}

for (const behavior of ['simple', 'preload']) {
  test(`SFVNetworkStepHarness (${behavior}) at L0 climbs to the top rung after a 6 Mbps burst`, () => {
    for (const planMbps of [undefined, null]) {
      const { coldStart, afterBurst } = runBurstScenario({ behavior, planMbps });
      assert.ok(coldStart.length > 0 && coldStart.every(kbps => kbps === 300));
      assert.ok(afterBurst.length > 0);
      assert.ok(afterBurst.includes(5200), `expected 5200 in ${JSON.stringify(afterBurst)}`);
    }
  });

  test(`SFVNetworkStepHarness (${behavior}) at L1 restricts requested representations to the plan cap`, () => {
    for (const planMbps of [2.0, 2.5]) {
      const { coldStart, afterBurst } = runBurstScenario({ behavior, planMbps });
      assert.ok(coldStart.length > 0 && coldStart.every(kbps => kbps === 300));
      assert.ok(afterBurst.length > 0);
      const capKbps = planMbps * 1000 * SAFETY;
      assert.ok(
        afterBurst.every(kbps => kbps <= capKbps),
        `all of ${JSON.stringify(afterBurst)} must be <= ${capKbps}`
      );
      assert.ok(afterBurst.includes(1300), `expected 1300 in ${JSON.stringify(afterBurst)}`);
    }
  });
}
