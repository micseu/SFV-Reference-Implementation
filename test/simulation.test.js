import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import { calculateDataWastage } from '../src/output/SFVDataWastageCalculator.js';

const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);

const base = {
  maxTimeS: 7,
  swipeTimesS: [2.5, 5],
  transport: {
    capacityMbps: 4,
    latencyMs: 20,
    cancelTailBytes: 512,
    cancelTailMs: 20
  },
  rule: { activeBufferTargetSegments: 2 },
  seed: 7
};

function run(Rule, extra = {}) {
  const rule = new Rule();
  return new SFVSimulationController({
    dataset,
    rule,
    config: {
      ...base,
      ...extra,
      rule: { ...base.rule, ...(extra.rule ?? {}) }
    }
  }).run();
}

test('B1 simulation never prefetches future media before swipe', () => {
  const out = run(SFVCurrentVideoRule);
  for (const event of out.events.filter(
    event => event.eventType === 'REQUEST_STARTED' && event.resource?.resourceType === 'media'
  )) {
    const activeAt = event.time < 2.5 ? 'v1' : event.time < 5 ? 'v2' : 'v3';
    assert.equal(event.resource.videoId, activeAt);
  }
});

test('B2 simulation performs future-video media prefetch', () => {
  const out = run(SFVMultiVideoPrefetchRule, {
    rule: {
      max_preload_segments: 4,
      preload_segments_per_video: 2,
      activeBufferTargetSegments: 2
    }
  });
  const prefetched = out.events.filter(
    event =>
      event.eventType === 'REQUEST_STARTED' &&
      event.resource?.resourceType === 'media' &&
      ((event.time < 2.5 && event.resource.videoId !== 'v1') ||
        (event.time >= 2.5 && event.time < 5 && event.resource.videoId === 'v3'))
  );
  assert.ok(prefetched.length > 0);
});

test('simulation is deterministic', () => {
  const a = run(SFVMultiVideoPrefetchRule, {
    rule: { max_preload_segments: 3, preload_segments_per_video: 1 }
  });
  const b = run(SFVMultiVideoPrefetchRule, {
    rule: { max_preload_segments: 3, preload_segments_per_video: 1 }
  });
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.requests, b.requests);
});

test('session record uses schema v2 data-wastage terminology', () => {
  const out = run(SFVCurrentVideoRule);
  assert.equal(out.sessionRecord.schema_version, 2);
  assert.equal(out.sessionRecord.signaling_level, 'L0');
  assert.equal(out.sessionRecord.videos.length, 3);
  assert.ok('bytes_data_wastage' in out.sessionRecord.session_summary);
  assert.ok('data_wastage_by_reason' in out.sessionRecord.session_summary);
  assert.equal(
    out.events.find(event => event.eventType === 'SESSION_STARTED').scheduling.swipeCancellation,
    true
  );
});

test('swipe cancellation defaults to engine-driven cancellation and reaches terminal CANCELLED state', () => {
  const out = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: {
      maxTimeS: 1,
      swipeTimesS: [0.1],
      transport: { capacityMbps: 1, latencyMs: 0, cancelTailBytes: 100, cancelTailMs: 10 },
      rule: { activeBufferTargetSegments: 2 }
    }
  }).run();
  const swipeCancels = out.events.filter(
    event => event.eventType === 'REQUEST_ABORT_REQUESTED' && event.cause === 'SWIPE'
  );
  assert.ok(swipeCancels.length > 0);
  const swipeDecision = out.events.find(
    event => event.eventType === 'RULE_DECISION' && Math.abs(event.time - 0.1) < 1e-8
  );
  assert.ok(swipeDecision);
  assert.equal(
    swipeDecision.actions.some(action => action.actionType === 'ABORT'),
    false
  );
  assert.ok(out.events.some(event => event.eventType === 'REQUEST_CANCELLED'));
  assert.ok(
    out.requests.some(
      request =>
        request.state === 'CANCELLED' &&
        request.finalBytesDelivered >= request.bytesDeliveredAtAbort
    )
  );
});

test('swipe data wastage includes cancellation-tail bytes delivered after the swipe', () => {
  const out = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: {
      maxTimeS: 0.5,
      swipeTimesS: [0.1],
      transport: { capacityMbps: 1, latencyMs: 0, cancelTailBytes: 1000, cancelTailMs: 20 },
      rule: { activeBufferTargetSegments: 2 }
    }
  }).run();
  const firstVideoMediaDelivered = out.requests
    .filter(
      request => request.resource?.videoId === 'v1' && request.resource?.resourceType === 'media'
    )
    .reduce(
      (sum, request) => sum + (request.finalBytesDelivered ?? request.bytesDelivered ?? 0),
      0
    );
  const firstVideo = out.sessionRecord.videos.find(video => video.video_id === 'v1');
  assert.equal(firstVideo.watch_duration_s, 0);
  assert.equal(firstVideo.bytes_data_wastage, Math.round(firstVideoMediaDelivered));
  assert.ok(
    out.requests.some(
      request =>
        request.resource?.videoId === 'v1' &&
        request.state === 'CANCELLED' &&
        request.finalBytesDelivered > request.bytesDeliveredAtAbort
    )
  );
});

test('swipe cancellation false leaves old-video requests uncancelled by the engine', () => {
  const out = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: {
      maxTimeS: 1,
      swipeTimesS: [0.1],
      scheduling: { swipeCancellation: false },
      transport: { capacityMbps: 1, latencyMs: 0, cancelTailBytes: 100, cancelTailMs: 10 },
      rule: { activeBufferTargetSegments: 2 }
    }
  }).run();
  assert.equal(
    out.events.some(
      event => event.eventType === 'REQUEST_ABORT_REQUESTED' && event.cause === 'SWIPE'
    ),
    false
  );
  assert.equal(
    out.events.some(event => event.eventType === 'REQUEST_CANCELLED'),
    false
  );
  assert.equal(
    out.events
      .filter(event => event.eventType === 'RULE_DECISION')
      .some(event => event.actions.some(action => action.actionType === 'ABORT')),
    false
  );
});

test('swipe cancellation accepts only boolean values', () => {
  assert.throws(
    () =>
      new SFVSimulationController({
        dataset,
        rule: new SFVCurrentVideoRule(),
        config: { scheduling: { swipeCancellation: 'true' } }
      }),
    /must be true or false/
  );
  assert.doesNotThrow(
    () =>
      new SFVSimulationController({
        dataset,
        rule: new SFVCurrentVideoRule(),
        config: { scheduling: { swipeCancellation: true } }
      })
  );
  assert.doesNotThrow(
    () =>
      new SFVSimulationController({
        dataset,
        rule: new SFVCurrentVideoRule(),
        config: { scheduling: { swipeCancellation: false } }
      })
  );
});

test('prefetch at simulation cutoff is unresolved data, not data wastage', () => {
  const out = run(SFVMultiVideoPrefetchRule, {
    maxTimeS: 1,
    swipeTimesS: [],
    rule: { max_preload_segments: 4, preload_segments_per_video: 2 }
  });
  assert.equal(out.terminationReason, 'simulation_cutoff');
  assert.equal(out.sessionRecord.session_summary.bytes_data_wastage, 0);
  assert.ok(out.sessionRecord.session_summary.bytes_unresolved_at_cutoff > 0);
  assert.ok(
    out.sessionRecord.videos
      .filter(video => video.video_id !== 'v1')
      .some(video => video.bytes_media_delivered > 0)
  );
});

test('swipe converts downloaded but unconsumed bytes of the abandoned video into data wastage', () => {
  const out = run(SFVCurrentVideoRule, { maxTimeS: 3, swipeTimesS: [2.5] });
  const firstVideo = out.sessionRecord.videos.find(video => video.video_id === 'v1');
  assert.ok(firstVideo.bytes_data_wastage > 0);
  assert.ok(firstVideo.data_wastage_by_reason.swipe > 0);
  assert.equal(firstVideo.data_wastage_by_reason.session_end, 0);
});

test('explicit session end converts remaining downloaded media into data wastage', () => {
  const out = run(SFVMultiVideoPrefetchRule, {
    maxTimeS: 7,
    sessionEndTimeS: 1,
    swipeTimesS: [],
    rule: { max_preload_segments: 4, preload_segments_per_video: 2 }
  });
  assert.equal(out.terminationReason, 'session_end');
  assert.equal(out.sessionRecord.termination_reason, 'session_end');
  assert.ok(out.sessionRecord.session_summary.data_wastage_by_reason.session_end > 0);
  assert.equal(out.sessionRecord.session_summary.bytes_unresolved_at_cutoff, 0);
});

test('higher-quality replacement marks the earlier lower-quality segment as representation-superseded data wastage', () => {
  const requests = [
    {
      requestId: 'low',
      state: 'COMPLETED',
      endTime: 0.5,
      finalBytesDelivered: 100,
      resource: {
        videoId: 'v1',
        resourceType: 'media',
        mediaType: 'video',
        representationId: '0',
        segmentIndex: 0,
        startS: 0,
        durationS: 2
      }
    },
    {
      requestId: 'high',
      state: 'COMPLETED',
      endTime: 0.7,
      finalBytesDelivered: 200,
      resource: {
        videoId: 'v1',
        resourceType: 'media',
        mediaType: 'video',
        representationId: '1',
        segmentIndex: 0,
        startS: 0,
        durationS: 2
      }
    }
  ];
  const result = calculateDataWastage({
    dataset,
    requests,
    userEvents: [],
    playbacks: {
      v1: {
        positionS: 0,
        rendered: [
          {
            time: 0.8,
            segmentIndex: 0,
            representationId: '1',
            playbackPositionS: 0
          }
        ]
      }
    },
    terminationReason: 'simulation_cutoff'
  });
  assert.equal(Math.round(result.total.reasons.representation_superseded), 100);
  assert.equal(Math.round(result.total.total), 100);
  assert.equal(Math.round(result.total.unresolvedAtCutoff), 200);
});

test('multi-session runner keeps rule and session state independent', () => {
  const runner = new SFVSimulationRunner({
    dataset,
    sessions: [
      {
        ruleFactory: () => new SFVCurrentVideoRule(),
        config: { ...base, sessionId: 'ue-a', ueId: 0, maxTimeS: 3, swipeTimesS: [2.5] }
      },
      {
        ruleFactory: () => new SFVMultiVideoPrefetchRule(),
        config: {
          ...base,
          sessionId: 'ue-b',
          ueId: 1,
          maxTimeS: 3,
          swipeTimesS: [2.5],
          rule: {
            ...base.rule,
            max_preload_segments: 2,
            preload_segments_per_video: 1
          }
        }
      }
    ]
  });
  const results = runner.run();
  assert.equal(results.length, 2);
  assert.equal(results[0].sessionRecord.session_id, 'ue-a');
  assert.equal(results[1].sessionRecord.session_id, 'ue-b');
  assert.notDeepEqual(results[0].ruleState, results[1].ruleState);
});
