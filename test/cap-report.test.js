import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CAP_BUFFER_DELTA_S,
  SFVCapReportEmitter,
  buildCapReportFromSession
} from '../src/core/SFVCapReport.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';

function report(timeS, { stalled = false, bufferS = 3, videoId = 'v1' } = {}) {
  return Object.freeze({
    time_s: timeS,
    is_stalled: stalled,
    playable_buffer_s: bufferS,
    current_video_id: videoId,
    swipe_rate_per_s: 0
  });
}

test('buildCapReportFromSession matches pilot co-sim snapshot fields', () => {
  const snapshot = buildCapReportFromSession({
    timeS: 1.0,
    playback: {
      videoId: 'v1',
      positionS: 2,
      stalled: true,
      bufferEnd: () => 5
    },
    userEvents: [{ eventType: 'SWIPE', time: 0.5 }]
  });
  assert.equal(snapshot.time_s, 1);
  assert.equal(snapshot.is_stalled, true);
  assert.equal(snapshot.playable_buffer_s, 3);
  assert.equal(snapshot.current_video_id, 'v1');
  assert.equal(snapshot.swipe_rate_per_s, 1);
});

test('emitter emits first report and ignores steady state', () => {
  const emitter = new SFVCapReportEmitter();
  assert.equal(DEFAULT_CAP_BUFFER_DELTA_S, 1.0);
  assert.ok(emitter.poll(report(0)));
  assert.equal(emitter.poll(report(2, { bufferS: 3 + DEFAULT_CAP_BUFFER_DELTA_S / 2 })), null);
  assert.ok(emitter.poll(report(3, { bufferS: 3 + DEFAULT_CAP_BUFFER_DELTA_S })));
});

test('emitter emits on stall edges and video switches', () => {
  const emitter = new SFVCapReportEmitter();
  emitter.poll(report(0));
  assert.equal(emitter.poll(report(1.5, { stalled: true }))?.is_stalled, true);
  assert.equal(emitter.poll(report(3, { stalled: false }))?.is_stalled, false);
  assert.equal(emitter.poll(report(4.5, { videoId: 'v2' }))?.current_video_id, 'v2');
});

test('emitter rate-limits to one report per second and coalesces suppressed changes', () => {
  const emitter = new SFVCapReportEmitter();
  emitter.poll(report(0));
  assert.equal(emitter.poll(report(0.4, { stalled: true })), null);
  assert.equal(emitter.poll(report(0.9, { stalled: true })), null);
  const late = emitter.poll(report(1.0, { stalled: true }));
  assert.equal(late?.time_s, 1.0);
  assert.equal(late?.is_stalled, true);
});

test('emitter force bypasses the rate limit but not the change check', () => {
  const emitter = new SFVCapReportEmitter();
  emitter.poll(report(0));
  assert.equal(emitter.poll(report(0.2), { force: true }), null);
  assert.equal(emitter.poll(report(0.3, { stalled: true }), { force: true })?.is_stalled, true);
});

test('SFVSimulationController.drainCapReports emits once until state changes', () => {
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
  const [first, ...rest] = controller.drainCapReports(0.01);
  assert.equal(rest.length, 0);
  assert.equal(first.current_video_id, 'v1');
  assert.equal(typeof first.playable_buffer_s, 'number');
  assert.deepEqual(controller.drainCapReports(0.02), []);
  // Deprecated snapshot API still answers on every call and does not consume pending state.
  assert.equal(controller.buildCapReport(0.03).current_video_id, 'v1');
  assert.deepEqual(controller.drainCapReports(0.04), []);
});

test('SFVSimulationController.drainCapReports reports an induced stall within the rate limit', () => {
  const segments = Array.from({ length: 6 }, (_, index) => ({
    index,
    startS: index,
    durationS: 1
  }));
  const dataset = {
    videos: [
      {
        videoId: 'v1',
        representations: { video: [{ id: 'r0', bitrateKbps: 4000, segments }] }
      }
    ]
  };
  const controller = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: {
      sessionStartTimeS: 0,
      sessionEndTimeS: 20,
      maxTimeS: 20,
      swipeTimesS: [],
      transport: { capacityMbps: 2, latencyMs: 0 }
    }
  });
  controller.startAt(0);
  const stepS = 0.05;
  const reports = [];
  let drains = 0;
  for (let t = stepS; t <= 12 + 1e-9; t += stepS) {
    controller.advancePlaybackTo(t);
    for (const event of controller.transport.advanceTo(t)) controller.applyNetworkEvent(event);
    controller.decideAtEpoch();
    reports.push(...controller.drainCapReports(t));
    drains++;
  }
  assert.ok(
    reports.some(r => r.is_stalled),
    'expected at least one stalled CAP report'
  );
  assert.ok(reports.length < drains / 5, `${reports.length} reports for ${drains} drains`);
  for (let i = 1; i < reports.length; i++) {
    assert.ok(reports[i].time_s - reports[i - 1].time_s >= 1 - 1e-8, 'rate limit violated');
  }
});
