import test from 'node:test';
import assert from 'node:assert/strict';
import { SFVReferenceRuntime } from '../src/dashjs/SFVReferenceRuntime.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';

function bridgeSpy() {
  const calls = [];
  return {
    calls,
    async initialize(options) { calls.push(['initialize', options]); },
    async swipeNext(options) { calls.push(['swipeNext', options]); return options; }
  };
}

test('reference runtime forwards boolean swipe cancellation to the dash.js bridge', async () => {
  const bridge = bridgeSpy();
  const runtime = new SFVReferenceRuntime({ bridge, rule: new SFVCurrentVideoRule() });
  await runtime.initialize({ scheduling: { swipeCancellation: false } });
  await runtime.swipeNext();
  assert.deepEqual(bridge.calls, [
    ['initialize', { externallyControlled: true, swipeCancellation: false }],
    ['swipeNext', { cancelOutstandingRequests: false }]
  ]);
});

test('reference runtime defaults swipe cancellation to true', async () => {
  const bridge = bridgeSpy();
  const runtime = new SFVReferenceRuntime({ bridge, rule: new SFVCurrentVideoRule() });
  await runtime.initialize({});
  const result = await runtime.swipeNext();
  assert.deepEqual(result, { cancelOutstandingRequests: true });
});

test('reference runtime rejects non-boolean swipe cancellation', async () => {
  const bridge = bridgeSpy();
  const runtime = new SFVReferenceRuntime({ bridge, rule: new SFVCurrentVideoRule() });
  await assert.rejects(runtime.initialize({ scheduling: { swipeCancellation: 1 } }), /must be true or false/);
});
