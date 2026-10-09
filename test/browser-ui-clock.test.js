import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SFVBrowserServerClock } from '../src/browser/SFVBrowserServerClock.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('browser/server midpoint alignment chooses the shortest RTT and retains original samples', async () => {
  let now = 1;
  const readings = [
    { delay: 0.1, time: 11.05, id: 'first' },
    { delay: 0.02, time: 12.01, id: 'first' }
  ];
  const clock = new SFVBrowserServerClock({
    now: () => now,
    fetchImpl: async () => {
      const next = readings.shift();
      now += next.delay;
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          clock: 'node_performance_seconds',
          serverTimeS: next.time,
          serverInstanceId: next.id
        })
      };
    }
  });
  await clock.probe();
  assert.ok(Math.abs(clock.best.offsetS - 10) < 1e-9);
  now = 2;
  await clock.probe();
  assert.ok(Math.abs(clock.best.offsetS - 10) < 1e-9);
  assert.ok(Math.abs(clock.best.roundTripS - 0.02) < 1e-9);
  assert.ok(Math.abs(clock.serverToSessionS(15, 3) - 2) < 1e-9);
  const snapshot = clock.snapshot();
  assert.equal(snapshot.sampleCount, 2);
  assert.equal(snapshot.serverInstanceId, 'first');
  assert.ok(Math.abs(snapshot.exchangeErrorBoundS - 0.01) < 1e-9);
  assert.deepEqual(
    snapshot.recentSamples.map(s => s.serverTimeS),
    [11.05, 12.01]
  );
});

test('clock-aligned server capacity changes preserve original server timestamps and reject another server instance', async () => {
  let now = 1;
  const clock = new SFVBrowserServerClock({
    now: () => now,
    fetchImpl: async () => {
      now += 0.02;
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          clock: 'node_performance_seconds',
          serverTimeS: 11.01,
          serverInstanceId: 'server-A'
        })
      };
    }
  });
  await clock.probe();
  const network = {
    profile: {
      capacityTrace: [
        [0, 8],
        [4, 2]
      ]
    },
    serverInstanceId: 'server-A',
    startedAtServerS: 15,
    events: [
      { eventType: 'EMULATION_STARTED', atS: 0, capacityMbps: 8 },
      { eventType: 'NETWORK_CAPACITY_CHANGED', atS: 4, capacityMbps: 2 },
      { eventType: 'HTTP_STARTED', atS: 3 }
    ]
  };
  const aligned = clock.alignEmulatorEvents(network, { sessionEpochClientS: 5 });
  assert.deepEqual(
    aligned.map(e => e.time),
    [0, 4]
  );
  assert.deepEqual(
    aligned.map(e => e.serverTimeS),
    [15, 19]
  );
  assert.equal(network.events[0].serverTimeS, undefined, 'raw server events must stay untouched');
  assert.deepEqual(
    clock.alignEmulatorEvents(
      { ...network, serverInstanceId: 'other' },
      { sessionEpochClientS: 5 }
    ),
    []
  );
  assert.deepEqual(clock.alignEmulatorEvents(network, { sessionEpochClientS: null }), []);
});

test('server restart resets previous clock fit and missing synchronization never invents timestamps', async () => {
  let now = 1;
  const clock = new SFVBrowserServerClock({
    now: () => now,
    fetchImpl: async () => {
      const id = now < 2 ? 'old' : 'new';
      const serverTimeS = now + (id === 'old' ? 100 : 200);
      now += 0.02;
      return {
        ok: true,
        json: async () => ({
          schemaVersion: 1,
          clock: 'node_performance_seconds',
          serverTimeS,
          serverInstanceId: id
        })
      };
    }
  });
  assert.equal(clock.serverToSessionS(1, 0), null);
  await clock.probe();
  now = 2;
  await clock.probe();
  assert.equal(clock.snapshot().serverInstanceId, 'new');
  assert.equal(clock.snapshot().sampleCount, 1);
  assert.ok(clock.best.offsetS > 199);
});

test('welcome, JSON-only setup and sticky player + event-log workspace retain control IDs', () => {
  const html = fs.readFileSync(path.join(root, 'web/public/index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'web/public/main.js'), 'utf8');
  assert.match(html, /id="entry-screen"/);
  assert.match(html, /id="json-screen"[^>]*hidden/);
  assert.match(html, /id="workspace-screen"[^>]*hidden/);
  assert.match(html, /class="pinned-workspace"/);
  assert.match(html, /position:\s*sticky/);
  assert.match(html, /class="viewer-grid"/);
  for (const id of [
    'choose-json',
    'choose-manual',
    'start-experiment',
    'experimentconfig',
    'start',
    'swipe',
    'end',
    'video',
    'event-log',
    'copy-event-log',
    'export',
    'configure-new'
  ]) {
    assert.ok(html.includes(`id="${id}"`), `Missing UI control ${id}`);
  }
  assert.match(script, /showScreen\('workspace'\)/);
  assert.match(script, /SFVBrowserServerClock/);
  assert.match(script, /clockSynchronization/);
  assert.match(script, /alignedServerEvents/);
});

test('actual browser server reports same clock instance across clock and network endpoints', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-clock-server-'));
  const bundle = path.join(tmp, 'dist/modern/umd/dash.all.min.js');
  fs.mkdirSync(path.dirname(bundle), { recursive: true });
  fs.writeFileSync(
    bundle,
    'window.dashjs={MediaPlayer:()=>({create:()=>({updateSettings(){},parseSFVManifest(){}})})};'
  );
  const child = spawn(process.execPath, [path.join(root, 'web/server.mjs')], {
    cwd: root,
    env: { ...process.env, SFV_DASHJS_ROOT: tmp, PORT: '0' },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', s => {
    stderr += s;
  });
  let stdout = '';
  child.stdout.setEncoding('utf8');
  const base = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Server startup timeout: ${stderr} ${stdout}`)),
      5000
    );
    const onData = chunk => {
      stdout += chunk;
      const m = stdout.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (m) {
        clearTimeout(timer);
        child.stdout.off('data', onData);
        resolve(`http://127.0.0.1:${m[1]}`);
      }
    };
    child.stdout.on('data', onData);
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error(`Server exited ${code}: ${stderr}`));
    });
  });
  try {
    const reading = await (await fetch(`${base}/__sfv/clock`)).json();
    assert.equal(reading.clock, 'node_performance_seconds');
    assert.ok(Number.isFinite(reading.serverTimeS));
    const configured = await (
      await fetch(`${base}/__sfv/emulation`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          capacityTrace: [
            [0, 8],
            [4, 2]
          ],
          latencyMs: 40
        })
      })
    ).json();
    assert.equal(configured.serverInstanceId, reading.serverInstanceId);
    assert.ok(configured.startedAtServerS >= reading.serverTimeS);
    const recent = await (await fetch(`${base}/__sfv/emulation`)).json();
    assert.equal(recent.serverInstanceId, reading.serverInstanceId);
    assert.ok(recent.sampledAtServerS >= recent.startedAtServerS);
    assert.ok(Math.abs(recent.sampledAtServerS - recent.startedAtServerS - recent.elapsedS) < 0.02);
    const page = await (await fetch(base)).text();
    assert.match(page, /How would you like to start/);
  } finally {
    child.kill();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
