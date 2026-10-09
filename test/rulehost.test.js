import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { SFVMediaCatalog } from '../src/media/SFVMediaCatalog.js';
import { SFVRulesContext } from '../src/core/SFVRulesContext.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { snapshotContext } from '../src/rulehost/contextFromSnapshot.js';

const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);

function send(proc, rl, msg, stderr, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    let done = false;
    let timeout;
    function clean() {
      clearTimeout(timeout);
      rl.off('line', onLine);
      proc.off('error', onError);
      proc.off('exit', onExit);
    }
    function finish(error, response) {
      if (done) return;
      done = true;
      clean();
      if (error) reject(error);
      else resolve(response);
    }
    function onLine(line) {
      let response;
      try {
        response = JSON.parse(line);
      } catch (error) {
        finish(new Error(`Non-JSON RuleHost output: ${line}`, { cause: error }));
        return;
      }
      if (response.id === msg.id) finish(null, response);
    }
    function onError(error) {
      finish(error);
    }
    function onExit(code, signal) {
      finish(
        new Error(
          `RuleHost exited before response to ${msg.type}: code=${code}, signal=${signal}, stderr=${stderr()}`
        )
      );
    }
    rl.on('line', onLine);
    proc.once('error', onError);
    proc.once('exit', onExit);
    timeout = setTimeout(
      () => finish(new Error(`RuleHost timed out responding to ${msg.type}; stderr=${stderr()}`)),
      timeoutMs
    );
    try {
      proc.stdin.write(JSON.stringify(msg) + '\n', error => {
        if (error) finish(error);
      });
    } catch (error) {
      finish(error);
    }
  });
}

test('direct and persistent host produce identical action batch', { timeout: 15000 }, async t => {
  const catalog = new SFVMediaCatalog(dataset);
  catalog.markManifestAvailable('v1');
  const context = new SFVRulesContext({
    time: 0,
    session: { sessionId: 's' },
    playlist: catalog.getPlaylist(),
    currentVideoIndex: 0,
    catalog: catalog.getPolicyView(),
    store: [],
    requests: [],
    playback: { videoId: 'v1', positionS: 0, bufferedSegments: [], bufferRanges: [] },
    networkHistory: [],
    userHistory: [],
    playbackHistory: []
  });
  const direct = new SFVCurrentVideoRule();
  direct.reset({}, 1);
  const expected = direct.getSwitchRequest(context);
  // URL.pathname is not a usable Windows filesystem path (e.g. /C:/...).
  const hostPath = fileURLToPath(new URL('../src/rulehost/SFVRuleHost.js', import.meta.url));
  const proc = spawn(process.execPath, [hostPath], { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', chunk => {
    stderr += chunk;
  });
  const rl = readline.createInterface({ input: proc.stdout });
  t.after(() => {
    rl.close();
    if (proc.exitCode === null && proc.signalCode === null) proc.kill();
  });
  const getStderr = () => stderr;
  assert.equal(
    (
      await send(
        proc,
        rl,
        { id: 1, type: 'initialize', rule: 'current', config: {}, seed: 1 },
        getStderr
      )
    ).ok,
    true
  );
  const got = await send(
    proc,
    rl,
    { id: 2, type: 'decide', observations: [], context: snapshotContext(context) },
    getStderr
  );
  assert.deepEqual(got.actionBatch, expected);
  const exited = new Promise((resolve, reject) => {
    proc.once('exit', (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(`RuleHost shutdown exit code=${code}, signal=${signal}, stderr=${stderr}`)
          )
    );
  });
  await send(proc, rl, { id: 3, type: 'shutdown' }, getStderr);
  await exited;
});
