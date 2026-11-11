import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  validateBrowserExperimentConfig,
  parseBrowserExperimentConfig,
  resolveBrowserNetworkProfile
} from '../src/browser/SFVBrowserExperimentConfig.js';

const example = JSON.parse(
  fs.readFileSync(
    fileURLToPath(new URL('../web/public/experiment-example.json', import.meta.url)),
    'utf8'
  )
);

test('versioned browser JSON example resolves to a single-UE browser run', () => {
  const run = parseBrowserExperimentConfig(JSON.stringify(example));
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.experimentId, 'browser-b2-example');
  assert.equal(run.abr.name, 'prefetch');
  assert.deepEqual(
    run.playlist.map(item => item.videoId),
    ['v1', 'v2', 'v3']
  );
  assert.deepEqual(resolveBrowserNetworkProfile(run).capacityTrace, [
    [0, 8],
    [4, 2],
    [8, 5]
  ]);
  assert.deepEqual(run.userModel.swipeTimesS, [3, 6]);
  assert.equal(run.cache.maxBytes, null);
  assert.equal(run.requestRetry.maxRetries, 0);
});

test('manual and JSON configurations accept explicit zero limits and default independently of form values', () => {
  const run = validateBrowserExperimentConfig({
    schemaVersion: 1,
    experimentId: 'single',
    abr: { name: 'current' },
    playlist: ['v2', 'v1'],
    network: null,
    userModel: null,
    scheduling: { maxConcurrentRequests: 0 },
    cache: { maxBytes: null }
  });
  assert.equal(run.abr.config.max_preload_segments, 4);
  assert.equal(run.scheduling.maxConcurrentRequests, 0);
  assert.equal(run.cache.maxBytes, null);
  assert.equal(run.network, null);
  assert.equal(run.userModel, null);
});

test('rejects malformed and non-browser experiment specs instead of silently ignoring unsupported parameters', () => {
  assert.throws(() => parseBrowserExperimentConfig('{bad'), /Invalid experiment JSON/);
  assert.throws(
    () => validateBrowserExperimentConfig({ ...example, schemaVersion: 2 }),
    /schemaVersion/
  );
  assert.throws(
    () => validateBrowserExperimentConfig({ ...example, sessions: [] }),
    /sessions is not supported/
  );
  assert.throws(
    () => validateBrowserExperimentConfig({ ...example, abr: { name: 'other' } }),
    /abr.name/
  );
  assert.throws(() => validateBrowserExperimentConfig({ ...example, playlist: [] }), /playlist/);
  assert.throws(
    () => validateBrowserExperimentConfig({ ...example, playlist: ['v1', 'v1'] }),
    /Duplicate videoId/
  );
  assert.throws(
    () => validateBrowserExperimentConfig({ ...example, cache: { maxBytes: -1 } }),
    /cache.maxBytes/
  );
  assert.throws(
    () =>
      validateBrowserExperimentConfig({ ...example, scheduling: { maxConcurrentRequests: 1.1 } }),
    /maxConcurrentRequests/
  );
  assert.throws(
    () =>
      validateBrowserExperimentConfig({
        ...example,
        network: {
          capacityTrace: [
            [0, 8],
            [0, 9]
          ]
        }
      }),
    /capacityTrace/
  );
  assert.throws(
    () =>
      validateBrowserExperimentConfig({
        ...example,
        network: { capacityMbps: 8, capacityTrace: [[0, 8]] }
      }),
    /OR/
  );
  assert.throws(
    () =>
      validateBrowserExperimentConfig({
        ...example,
        network: { capacityGenerator: { type: 'seeded', seed: 2 }, capacityMbps: 4 }
      }),
    /OR/
  );
  assert.throws(
    () =>
      validateBrowserExperimentConfig({
        ...example,
        userModel: { type: 'sequence', swipeTimesS: [4, 3] }
      }),
    /swipe times/i
  );
  assert.throws(
    () => validateBrowserExperimentConfig({ ...example, userModel: { type: 'invalid' } }),
    /userModel.type/
  );
  assert.throws(
    () =>
      validateBrowserExperimentConfig({
        ...example,
        playlist: [{ videoId: 'a', manifestUrl: 'javascript:alert(1)' }]
      }),
    /HTTP\(S\)/
  );
});

test('resolves seeded capacity reproducibly but retains original seed in exported config', () => {
  const config = validateBrowserExperimentConfig({
    ...example,
    network: {
      capacityGenerator: {
        type: 'seeded',
        seed: 7,
        capacityChoicesMbps: [2, 5],
        holdDurationRangeS: [1, 3],
        changes: 3
      }
    }
  });
  const original = structuredClone(config);
  const first = resolveBrowserNetworkProfile(config);
  const second = resolveBrowserNetworkProfile(config);
  assert.deepEqual(first, second);
  assert.deepEqual(config, original);
  assert.equal(first.capacityGenerator, undefined);
  assert.ok(first.capacityTrace.length > 0);
});

test('browser page provides an editable JSON experiment launcher without removing manual session controls', () => {
  const html = fs.readFileSync(
    fileURLToPath(new URL('../web/public/index.html', import.meta.url)),
    'utf8'
  );
  const main = fs.readFileSync(
    fileURLToPath(new URL('../web/public/main.js', import.meta.url)),
    'utf8'
  );
  assert.match(html, /id="experimentconfig"/);
  assert.match(html, /id="start-experiment"/);
  assert.match(html, /id="example-config"/);
  assert.match(html, /id="start"[^>]*>Start Session</);
  assert.match(main, /parseBrowserExperimentConfig\(\$\('experimentconfig'\)\.value\)/);
  assert.match(main, /startExperiment\(config,\s*'json-editor'\)/);
  assert.match(main, /configuration:\s*structuredClone\(config\)/);
});
