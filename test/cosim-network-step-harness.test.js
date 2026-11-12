import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';
import { SFVNetworkStepHarness } from '../src/index.js';

const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);

function createHarness(overrides = {}) {
  return new SFVNetworkStepHarness({
    dataset,
    sessions: [
      {
        ue_id: 0,
        player_behavior: 'simple',
        config: { sessionStartTimeS: 0, sessionEndTimeS: 4, swipeTimesS: [] }
      }
    ],
    duration_s: 4,
    network_backend: 'test',
    ...overrides
  });
}

function step(time_s, events = [], extra = {}) {
  return { time_s, events, is_final: false, ...extra };
}

function completions(actions, time_s) {
  return actions
    .filter(action => action.op === 'submit_request')
    .map(action => ({
      event_type: 'DownloadCompleted',
      ue_id: action.ue_id,
      request_id: action.request_id,
      time_s
    }));
}

test('harness submits requests, consumes completions and returns session results', () => {
  const harness = createHarness();
  let reply = harness.onStep(step(0));
  assert.equal(reply.type, 'player_actions');
  assert.ok(reply.actions.some(action => action.op === 'submit_request'));
  for (let t = 0.5; t < 4; t += 0.5) {
    reply = harness.onStep(step(t, completions(reply.actions, t)));
    assert.equal(reply.type, 'player_actions');
  }
  const final = harness.onStep({ time_s: 4, events: [], is_final: true });
  assert.equal(final.type, 'player_step_result');
  assert.deepEqual(final.actions, []);
  assert.equal(final.result.network_backend, 'test');
  assert.deepEqual(
    final.result.sessions.map(session => session.ue_id),
    [0]
  );
  assert.ok(final.result.sessions[0].result);
  assert.throws(() => harness.onStep(step(4)), /already finished/);
});

test('harness rejects invalid step sequences', () => {
  assert.throws(() => createHarness().onStep(step(0.5)), /must be t=0/);
  const harness = createHarness();
  harness.onStep(step(0));
  assert.throws(() => harness.onStep(step(0)), /must progress/);
  assert.throws(
    () => harness.onStep({ time_s: 1, events: [], is_final: true }),
    /does not match experiment duration/
  );
  assert.throws(
    () => harness.onStep(step(1, [{ event_type: 'DownloadCompleted', ue_id: 7, time_s: 1 }])),
    /Invalid NetworkStep event/
  );
});

test('harness applies a CSP snapshot only when it changes', () => {
  const harness = createHarness();
  const { controller } = harness.states.get(0);
  const updates = [];
  const original = controller.applyCspUpdate.bind(controller);
  controller.applyCspUpdate = (fields, timeS) => {
    updates.push({ fields, timeS });
    return original(fields, timeS);
  };
  const fields = { plan_downlink_mbps: 10 };
  harness.onStep(step(0, [], { collaboration: { csp_by_ue: { 0: fields } } }));
  harness.onStep(step(0.5, [], { collaboration: { csp_by_ue: { 0: fields } } }));
  harness.onStep(step(1, [], { collaboration: { csp_by_ue: { 0: { plan_downlink_mbps: 5 } } } }));
  harness.onStep(step(1.5));
  assert.deepEqual(
    updates.map(update => [update.timeS, update.fields.plan_downlink_mbps]),
    [
      [0, 10],
      [1, 5]
    ]
  );
});

test('harness drains CAP reports per started UE', () => {
  const harness = createHarness({
    sessions: [
      {
        ue_id: 0,
        player_behavior: 'simple',
        config: { sessionStartTimeS: 0, sessionEndTimeS: 4, swipeTimesS: [] }
      },
      {
        ue_id: 1,
        player_behavior: 'simple',
        config: { sessionStartTimeS: 2, sessionEndTimeS: 4, swipeTimesS: [] }
      }
    ]
  });
  harness.onStep(step(0));
  const reports = harness.getCapReports();
  assert.deepEqual(Object.keys(reports), ['0']);
  assert.equal(reports['0'].current_video_id, 'v1');
  assert.deepEqual(harness.getCapReports(), {});
});

test('worker answers line-delimited JSON messages', async () => {
  const worker = spawn(
    process.execPath,
    [new URL('../scripts/cosim-network-step-worker.mjs', import.meta.url).pathname],
    { stdio: ['pipe', 'pipe', 'inherit'] }
  );
  const lines = readline.createInterface({ input: worker.stdout })[Symbol.asyncIterator]();
  async function exchange(message) {
    worker.stdin.write(JSON.stringify(message) + '\n');
    return JSON.parse((await lines.next()).value);
  }
  try {
    assert.deepEqual(await exchange({ type: 'network_step', step: step(0) }), {
      type: 'error',
      message: 'Player not initialized'
    });
    const config = {
      dataset,
      sessions: [{ ue_id: 0, config: { sessionStartTimeS: 0, sessionEndTimeS: 1 } }],
      duration_s: 1,
      network_backend: 'test'
    };
    assert.deepEqual(await exchange({ type: 'initialize', config }), { type: 'initialized' });
    assert.equal((await exchange({ type: 'network_step', step: step(0) })).type, 'player_actions');
    assert.equal((await exchange({ type: 'cap_reports' })).type, 'cap_reports');
    assert.match((await exchange({ type: 'unknown' })).message, /Unknown IPC message/);
  } finally {
    worker.stdin.end();
  }
});
