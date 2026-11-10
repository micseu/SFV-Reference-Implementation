import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCapReportFromSession } from '../src/core/SFVCapReport.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';

test('buildCapReportFromSession matches pilot co-sim snapshot fields', () => {
  const report = buildCapReportFromSession({
    timeS: 1.0,
    playback: {
      videoId: 'v1',
      positionS: 2,
      stalled: true,
      bufferEnd: () => 5,
    },
    userEvents: [{ eventType: 'SWIPE', time: 0.5 }],
  });
  assert.equal(report.time_s, 1);
  assert.equal(report.is_stalled, true);
  assert.equal(report.playable_buffer_s, 3);
  assert.equal(report.current_video_id, 'v1');
  assert.equal(report.swipe_rate_per_s, 1);
});

test('SFVSimulationController.buildCapReport delegates to core helper', () => {
  const dataset = {
    videos: [{
      videoId: 'v1',
      representations: { video: [{ id: 'r0', bitrateKbps: 500, segments: [{ index: 0, startS: 0, durationS: 5 }] }] },
    }],
  };
  const controller = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: { sessionStartTimeS: 0, sessionEndTimeS: 6, swipeTimesS: [] },
  });
  controller.startAt(0);
  const report = controller.buildCapReport(0.01);
  assert.equal(report.current_video_id, 'v1');
  assert.equal(typeof report.playable_buffer_s, 'number');
});
