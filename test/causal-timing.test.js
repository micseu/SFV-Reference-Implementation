import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runExperiment } from '../scripts/run-experiment.mjs';
import { validateExperimentSpec } from '../src/experiment/SFVExperimentSpec.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const profile = JSON.parse(
  fs.readFileSync(path.join(root, 'examples/causal-simple-timing.json'), 'utf8')
);
const dataset = JSON.parse(
  fs.readFileSync(path.join(root, 'fixtures/content/content.json'), 'utf8')
);
function run(
  t,
  { timing = profile, swipeTimesS = [], playlist = ['v1'], durationS = 5, abr = 'current' } = {}
) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-causal-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const spec = {
    schemaVersion: 1,
    experimentId: 'causal-unit',
    content: { dataset, playlist },
    network: { capacityMbps: 8, latencyMs: 40 },
    sessions: [
      {
        abr: { name: abr },
        config: {
          playbackTiming: timing,
          seed: 47,
          maxTimeS: durationS,
          sessionDurationS: durationS,
          swipeTimesS,
          scheduling: { maxConcurrentRequests: 2 }
        }
      }
    ]
  };
  runExperiment(spec, dir);
  return JSON.parse(fs.readFileSync(path.join(dir, 'ue-0-result.json'), 'utf8'));
}
const events = (r, type, id) =>
  r.events.filter(e => e.eventType === type && (!id || e.videoId === id));

test('causal-simple validates all five model parameters; browser trace remains separate', () => {
  const base = {
    schemaVersion: 1,
    experimentId: 'model',
    content: { playlist: ['v1'] },
    sessions: [{ abr: { name: 'current' }, config: { playbackTiming: profile } }]
  };
  assert.doesNotThrow(() => validateExperimentSpec(base));
  for (const field of [
    'slotPreparationS',
    'appendProcessingS',
    'startupDelayS',
    'recoveryDelayS',
    'observationIntervalS'
  ]) {
    const bad = structuredClone(base);
    bad.sessions[0].config.playbackTiming[field] = field === 'observationIntervalS' ? 0 : -1;
    assert.throws(() => validateExperimentSpec(bad), new RegExp(field));
  }
  const extra = structuredClone(base);
  extra.sessions[0].config.playbackTiming.unverifiedBrowserTrace = [1, 2];
  assert.throws(() => validateExperimentSpec(extra), /Unknown playbackTiming field/);
});

test('a complete manifest precedes slot preparation and media requests, append precedes start', t => {
  const result = run(t);
  const manifest = result.requests.find(r => r.resource.resourceType === 'manifest');
  const media = result.requests.find(r => r.resource.resourceType === 'media');
  const preparing = events(result, 'PLAYBACK_SLOT_PREPARING', 'v1')[0];
  const slot = events(result, 'PLAYBACK_SLOT_READY', 'v1')[0];
  const pending = events(result, 'MEDIA_APPEND_PENDING', 'v1')[0];
  const appended = events(result, 'RESOURCE_APPENDED', 'v1')[0];
  const started = events(result, 'PLAYBACK_STARTED', 'v1')[0];
  assert.ok(preparing.time >= manifest.endTime - 1e-8);
  assert.ok(Math.abs(slot.time - preparing.time - profile.slotPreparationS) < 1e-8);
  assert.ok(media.startTime >= slot.time - 1e-8);
  assert.ok(pending && appended && started);
  assert.ok(appended.time >= pending.time + profile.appendProcessingS - 1e-8);
  assert.ok(started.time >= appended.time + profile.startupDelayS - 1e-8);
  assert.equal(result.terminationReason, 'session_end');
});

test('observation ticks, not exact segment boundary, trigger subsequent media request', t => {
  const config = { ...profile, observationIntervalS: 0.31 };
  const result = run(t, { timing: config, durationS: 7 });
  const start = events(result, 'PLAYBACK_STARTED', 'v1')[0].time;
  const boundary = events(result, 'PLAYBACK_POSITION_UPDATED', 'v1').find(
    e => e.segmentIndex === 1
  );
  assert.ok(boundary, 'a media-position event must cross segment 1 boundary');
  const n = (boundary.time - start) / config.observationIntervalS;
  assert.ok(Math.abs(n - Math.round(n)) < 1e-7, 'boundary notification must be a sampled position');
  assert.ok(
    boundary.time > start + 2 + 0.01,
    'notification must occur after the 2s physical boundary'
  );
  const third = result.requests.find(
    r => r.resource.resourceType === 'media' && r.resource.segmentIndex === 2
  );
  assert.ok(third && third.startTime >= boundary.time - 1e-8);
});

test('swipe invalidates append completions from the departed playback slot', t => {
  const timing = { ...profile, slotPreparationS: 0, appendProcessingS: 0.6, startupDelayS: 0 };
  const result = run(t, { timing, playlist: ['v1', 'v2'], swipeTimesS: [0.25], durationS: 3 });
  assert.ok(events(result, 'MEDIA_APPEND_PENDING', 'v1').length > 0);
  assert.equal(
    events(result, 'RESOURCE_APPENDED', 'v1').length,
    0,
    'late v1 completion must not change active v2 playback'
  );
  assert.ok(events(result, 'RESOURCE_APPENDED', 'v2').length > 0);
});

test('simple timing is deterministic and does not consume browser timing or rule actions', t => {
  const a = run(t, { durationS: 4 }),
    b = run(t, { durationS: 4 });
  const relevant = r =>
    r.events
      .filter(e =>
        [
          'PLAYBACK_SLOT_READY',
          'RESOURCE_APPENDED',
          'PLAYBACK_POSITION_UPDATED',
          'PLAYBACK_STARTED'
        ].includes(e.eventType)
      )
      .map(e => [e.eventType, e.videoId, e.time, e.segmentIndex ?? null]);
  assert.deepEqual(relevant(a), relevant(b));
  assert.ok(a.events.filter(e => e.eventType === 'RULE_DECISION').length > 0);
});

test('standalone controller enforces slot readiness before admitting active media', async () => {
  const [{ SFVSimulationController }, { SFVCurrentVideoRule }] = await Promise.all([
    import('../src/simulation/SFVSimulationController.js'),
    import('../src/rules/SFVCurrentVideoRule.js')
  ]);
  const result = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: {
      playbackTiming: profile,
      maxTimeS: 3,
      sessionDurationS: 3,
      swipeTimesS: []
    }
  }).run();
  const slot = events(result, 'PLAYBACK_SLOT_READY', 'v1')[0];
  assert.ok(slot);
  assert.ok(
    result.requests
      .filter(r => r.resource.resourceType === 'media')
      .every(r => r.startTime >= slot.time - 1e-8)
  );
});
