import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repeatability, cacheIsolation } from '../scripts/validation/supplementary-experiments.mjs';
import { prepareSupplementary } from '../scripts/validation/prepare-supplementary.mjs';
import { validateBrowserExperimentConfig } from '../src/browser/SFVBrowserExperimentConfig.js';

function fixture({
  start = 10,
  page = 'page-A',
  network = 8,
  mediaBytes = 100,
  missingServer = false
} = {}) {
  const cfg = {
    schemaVersion: 1,
    experimentId: 'repeatable-b1',
    seed: 7,
    abr: { name: 'current' },
    playlist: [{ videoId: 'v1' }],
    network: { capacityMbps: network, latencyMs: 40 }
  };
  const resources = [
    ['manifest', '/media/v1/manifest-video-only.mpd', 2015],
    ['init', '/media/v1/init-0.m4s', 826],
    ['media', '/media/v1/chunk-0-00001.m4s', mediaBytes]
  ];
  const requests = resources.map(([resourceType, pathname, bytesDelivered], i) => ({
    resource: { videoId: 'v1', resourceType, url: `http://127.0.0.1:8080${pathname}` },
    startTime: i * 0.02,
    firstByteTime: i * 0.02 + 0.04,
    endTime: i * 0.02 + 0.05,
    bytesDelivered,
    state: 'COMPLETED'
  }));
  const serverEvents = resources.flatMap(([, pathName, bytesDelivered], i) => [
    { eventType: 'HTTP_STARTED', path: pathName, atS: i * 0.02 },
    {
      eventType: 'HTTP_COMPLETED',
      path: pathName,
      deliveredBytes: bytesDelivered,
      atS: i * 0.02 + 0.05
    }
  ]);
  if (missingServer) serverEvents.pop();
  return {
    timeS: 5,
    terminationReason: 'session_end',
    requestTerminationSettled: true,
    events: [
      { eventType: 'SESSION_STARTED', time: 0 },
      { eventType: 'PLAYBACK_STARTED', time: 0.2, videoId: 'v1' },
      {
        eventType: 'ABR_DECISION_DIAGNOSTIC',
        time: 0.1,
        diagnostic: {
          context: { currentVideo: { videoId: 'v1' } },
          decision: {
            actions: [
              { actionType: 'FETCH_MEDIA', videoId: 'v1', segmentIndex: 0, representationId: '0' }
            ]
          }
        }
      },
      { eventType: 'SESSION_ENDED', time: 5 }
    ],
    requests,
    sessionRecord: { session_summary: { initial_playback_delay_s: 0.2 } },
    browserExperiment: {
      pageInstanceId: page,
      cacheIsolation: { mode: 'http-no-store', deletedEntries: 0, failures: [] },
      profile: { configuration: cfg, resolvedNetwork: { capacityMbps: network, latencyMs: 40 } },
      clockSynchronization: { sessionStartServerTimeS: start, serverInstanceId: 'server-A' },
      serverNetwork: {
        serverInstanceId: 'server-A',
        startedAtServerS: start - 0.01,
        profile: { capacityTrace: [[0, network]], latencyMs: 40, faults: [] },
        events: serverEvents
      }
    }
  };
}
function temporary(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-supplementary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('repeatability accepts three distinct, comparable browser runs and reports timing distributions', t => {
  const dir = temporary(t);
  const runs = [fixture({ start: 10 }), fixture({ start: 40 }), fixture({ start: 70 })];
  const report = repeatability(runs, { outputDirectory: dir });
  assert.equal(report.status, 'accepted');
  assert.equal(report.runCount, 3);
  assert.equal(report.checks.length, 6);
  assert.ok(fs.existsSync(path.join(dir, 'repeatability-report.json')));
  runs[2].events.find(e => e.eventType === 'PLAYBACK_STARTED').time = 2;
  assert.equal(repeatability(runs, { outputDirectory: dir }).status, 'review-required');
});

test('repeatability rejects insufficient, duplicate, reordered and mismatched-profile exports', t => {
  const dir = temporary(t);
  const a = fixture({ start: 10 }),
    b = fixture({ start: 40 }),
    c = fixture({ start: 70 });
  assert.throws(() => repeatability([a, b], { outputDirectory: dir }), /At least 3/);
  assert.throws(() => repeatability([a, a, c], { outputDirectory: dir }), /duplicate/);
  assert.throws(() => repeatability([b, a, c], { outputDirectory: dir }), /ordered/);
  assert.throws(
    () => repeatability([a, b, fixture({ start: 70, network: 4 })], { outputDirectory: dir }),
    /different experiment/
  );
});

test('cache evidence requires same loaded page, fresh server reconfiguration and real completed HTTP bytes', t => {
  const dir = temporary(t);
  const a = fixture({ start: 10 }),
    b = fixture({ start: 40 });
  const report = cacheIsolation(a, b, { outputDirectory: dir });
  assert.equal(report.status, 'accepted', JSON.stringify(report.checks.filter(x => !x.passed)));
  assert.equal(report.runs[1].clientCompleted, 3);
  assert.ok(fs.existsSync(path.join(dir, 'cache-isolation-report.json')));
  assert.equal(
    cacheIsolation(a, fixture({ start: 40, missingServer: true }), { outputDirectory: dir }).status,
    'review-required'
  );
  assert.throws(
    () => cacheIsolation(a, fixture({ start: 40, page: 'another-page' }), { outputDirectory: dir }),
    /pageInstanceId/
  );
  assert.throws(
    () => cacheIsolation(a, fixture({ start: 40, network: 4 }), { outputDirectory: dir }),
    /different experiment/
  );
  assert.throws(() => cacheIsolation(a, a, { outputDirectory: dir }), /duplicate/);
});

test('supplementary browser configurations are valid, deterministic and distinct by ABR', t => {
  const dir = temporary(t);
  const files = prepareSupplementary(dir);
  const read = file => validateBrowserExperimentConfig(JSON.parse(fs.readFileSync(file, 'utf8')));
  const b1 = read(files.B1),
    b2 = read(files.B2);
  assert.equal(b1.abr.name, 'current');
  assert.equal(b2.abr.name, 'prefetch');
  assert.deepEqual(b1.userModel.swipeTimesS, [7, 15]);
  assert.equal(b2.userModel.sessionDurationS, 22);
  assert.deepEqual(prepareSupplementary(dir), files);
  assert.deepEqual(read(files.B1), b1);
});

test('missing measurements fail repeatability and client/server byte discrepancies fail cache isolation', t => {
  const dir = temporary(t);
  const runs = [fixture({ start: 10 }), fixture({ start: 40 }), fixture({ start: 70 })];
  delete runs[2].sessionRecord.session_summary.initial_playback_delay_s;
  assert.equal(repeatability(runs, { outputDirectory: dir }).status, 'review-required');
  const first = fixture({ start: 10 }),
    second = fixture({ start: 40 });
  second.requests[2].bytesDelivered += 1;
  assert.equal(cacheIsolation(first, second, { outputDirectory: dir }).status, 'review-required');
});

test('B2 repeatability identifies prefetched video qualities from first appended segment', t => {
  const dir = temporary(t);
  const runs = [10, 40, 70].map(start => {
    const result = fixture({ start });
    result.browserExperiment.profile.configuration.abr.name = 'prefetch';
    result.browserExperiment.profile.configuration.playlist = ['v1', 'v2', 'v3'].map(videoId => ({
      videoId
    }));
    result.events.push({ eventType: 'SWIPE', time: 1.5 }, { eventType: 'SWIPE', time: 3 });
    for (const [i, videoId] of ['v1', 'v2', 'v3'].entries()) {
      result.events.push({
        eventType: 'RESOURCE_APPENDED',
        videoId,
        segmentIndex: 0,
        representationId: i === 0 ? '0' : '1',
        time: i * 1.5 + 0.1
      });
      if (i > 0)
        result.events.push({ eventType: 'PLAYBACK_STARTED', videoId, time: i * 1.5 + 0.2 });
    }
    return result;
  });
  const report = repeatability(runs, { outputDirectory: dir });
  assert.equal(report.status, 'accepted');
  const quality = report.checks.find(c => c.label.startsWith('First-used'));
  assert.equal(quality.passed, true);
  assert.deepEqual(quality.detail, [
    { v1: '0', v2: '1', v3: '1' },
    { v1: '0', v2: '1', v3: '1' },
    { v1: '0', v2: '1', v3: '1' }
  ]);
  runs[2].events.find(
    e => e.eventType === 'RESOURCE_APPENDED' && e.videoId === 'v3'
  ).representationId = '0';
  assert.equal(repeatability(runs, { outputDirectory: dir }).status, 'review-required');
  runs[2].events = runs[2].events.filter(
    e => !(e.eventType === 'RESOURCE_APPENDED' && e.videoId === 'v3')
  );
  assert.equal(repeatability(runs, { outputDirectory: dir }).status, 'review-required');
  // A later B2 segment must also be checked, even if segment 0 stays stable.
  runs[2].events.push({
    eventType: 'RESOURCE_APPENDED',
    videoId: 'v3',
    segmentIndex: 0,
    representationId: '1',
    time: 3.2
  });
  for (const run of runs)
    run.events.push({
      eventType: 'RESOURCE_APPENDED',
      videoId: 'v2',
      segmentIndex: 1,
      representationId: '1',
      time: 2.4
    });
  runs[2].events.find(e => e.videoId === 'v2' && e.segmentIndex === 1).representationId = '2';
  const later = repeatability(runs, { outputDirectory: dir });
  assert.equal(later.checks.find(c => c.label.startsWith('First-used')).passed, true);
  assert.equal(later.checks.find(c => c.label.startsWith('All appended')).passed, false);
});
