import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runExperiment } from '../scripts/run-experiment.mjs';
import { validateExperimentSpec } from '../src/experiment/SFVExperimentSpec.js';

const baseSpec = {
  schemaVersion: 1,
  experimentId: 'test-exp',
  content: { playlist: ['v2', 'v1'] },
  network: { capacityMbps: 8, latencyMs: 0 },
  timingDefaults: { maxTimeS: 5 },
  sessions: [
    {
      abr: { name: 'current', config: { activeBufferTargetSegments: 1 } },
      config: {
        sessionId: 'u0',
        ueId: 0,
        sessionStartTimeS: 0,
        sessionDurationS: 3,
        scheduling: { maxConcurrentRequests: 1 },
        userModel: { type: 'sequence', swipeTimesS: [1] }
      }
    }
  ]
};

test('versioned experiment config controls playlist, ABR and per-UE request limit and exports resolved artifacts', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-exp-'));
  const result = runExperiment(baseSpec, tmp);
  assert.equal(result.summary[0].abr, 'current');
  const resolved = JSON.parse(fs.readFileSync(path.join(tmp, 'experiment-config.resolved.json')));
  assert.deepEqual(resolved.content.playlist, ['v2', 'v1']);
  assert.equal(resolved.sessions[0].scheduling.maxConcurrentRequests, 1);
  assert.ok(fs.existsSync(path.join(tmp, 'resolved-network-trace.json')));
  assert.ok(fs.existsSync(path.join(tmp, 'resolved-user-events.json')));
  const session = JSON.parse(fs.readFileSync(path.join(tmp, 'ue-0-session.json')));
  assert.equal(session.videos[0].video_id, 'v2');
});

test('experiment schema rejects network-level concurrency', () => {
  assert.throws(
    () =>
      validateExperimentSpec({
        ...baseSpec,
        network: { capacityMbps: 8, maxConcurrentRequests: 2 }
      }),
    /per-UE/
  );
});
