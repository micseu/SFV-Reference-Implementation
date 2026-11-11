import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeCspFields } from '../src/core/SFVCspFields.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';

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
