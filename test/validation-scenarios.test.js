import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  prepareScenarios,
  fixtureAlignedDataset
} from '../scripts/validation/prepare-scenarios.mjs';
import {
  compareBrowserSimulation,
  compareOneTwo
} from '../scripts/validation/compare-scenarios.mjs';
import { SFVSharedNetworkTransport } from '../src/simulation/SFVSharedNetworkTransport.js';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';

const scenario = JSON.parse(
  fs.readFileSync(new URL('../scenarios/validation/scenario-b1-v1.json', import.meta.url))
);
const approx = (x, y, tolerance = 1e-8) => assert.ok(Math.abs(x - y) < tolerance, `${x} !== ${y}`);

test('one canonical scenario yields fixture- and clock-compatible browser/one-UE/two-UE inputs', () => {
  const { browser, one, two } = prepareScenarios(scenario);
  assert.equal(browser.abr.name, one.sessions[0].abr.name);
  assert.deepEqual(browser.network.capacityTrace, one.network.capacityTrace);
  assert.deepEqual(one.network, two.network);
  assert.deepEqual(browser.userModel.swipeTimesS, one.sessions[0].config.userModel.swipeTimesS);
  assert.deepEqual(one.sessions[0], two.sessions[0]);
  assert.deepEqual(
    { ...two.sessions[0].config, sessionId: null, ueId: null },
    { ...two.sessions[1].config, sessionId: null, ueId: null }
  );
  assert.equal(one.sessions[0].config.sessionStartTimeS, 0);
  assert.equal(
    one.content.dataset.videos[0].manifestBytes,
    fs.statSync(new URL('../fixtures/dash/v1/manifest-video-only.mpd', import.meta.url)).size
  );
  assert.equal(one.content.dataset.videos[0].representations.audio, undefined);
  assert.deepEqual(fixtureAlignedDataset(), one.content.dataset);
});

test('shared transport: with no fixed RTT, two identical simultaneous requests take exactly twice the payload time', () => {
  const measure = count => {
    const net = new SFVSharedNetworkTransport({
      capacityTrace: [
        [0, 8],
        [5, 4],
        [10, 9]
      ],
      latencyMs: 0
    });
    for (let i = 0; i < count; i++)
      net
        .forUE(i)
        .start(
          { requestId: `r-${i}`, bytesTotal: 500_000, resource: { resourceType: 'media' } },
          0
        );
    net.advanceTo(count === 1 ? 0.5 : 1);
    return net.get('r-0').endTime;
  };
  approx(measure(1), 0.5);
  approx(measure(2), 1);
  approx(measure(2) / measure(1), 2);
});

test('shared transport: capacity change is identical but prevents universal double-time assumption', () => {
  const measure = count => {
    const net = new SFVSharedNetworkTransport({
      capacityTrace: [
        [0, 8],
        [1, 4],
        [2, 10]
      ],
      latencyMs: 0
    });
    for (let i = 0; i < count; i++)
      net
        .forUE(i)
        .start(
          { requestId: `r-${i}`, bytesTotal: 1_000_000, resource: { resourceType: 'media' } },
          0
        );
    net.advanceTo(count === 1 ? 1 : 2.4);
    return net.get('r-0').endTime;
  };
  approx(measure(1), 1);
  approx(measure(2), 2.4);
  assert.notEqual(measure(2) / measure(1), 2);
});

test('two configured equal UEs retain exact symmetry on a shared changing-capacity trace', () => {
  const { one, two } = prepareScenarios(scenario);
  const run = spec => {
    const s = spec.sessions.map(session => ({
      ruleFactory: () => new SFVCurrentVideoRule(),
      config: { ...session.config, rule: session.abr.config }
    }));
    const runner = new SFVSimulationRunner({
      dataset: spec.content.dataset,
      sessions: s,
      network: spec.network
    });
    return { results: runner.run(), network: runner.lastNetworkReport };
  };
  const a = run(one),
    b = run(two),
    report = compareOneTwo(
      a.results[0],
      b.results[0],
      b.results[1],
      a.network,
      b.network,
      scenario
    );
  assert.equal(report.status, 'invariants-passed');
  assert.ok(report.earlyPreCapacityChangeMediaRatios.length >= 2);
  approx(report.earlyPreCapacityChangeMediaRatios[0].ratio, 2);
  assert.ok(report.meanMediaRatio > 1 && report.meanMediaRatio < 2);
  assert.ok(report.matchedRequests.length > 0);
});

test('browser comparator rejects missing browser telemetry rather than treating it as parity', () => {
  const { one } = prepareScenarios(scenario);
  const runner = new SFVSimulationRunner({
    dataset: one.content.dataset,
    sessions: [
      {
        ruleFactory: () => new SFVCurrentVideoRule(),
        config: { ...one.sessions[0].config, rule: one.sessions[0].abr.config }
      }
    ],
    network: one.network
  });
  const simulated = runner.run()[0];
  const insufficient = {
    events: [],
    requests: [],
    sessionRecord: { session_summary: { initial_playback_delay_s: null } }
  };
  const report = compareBrowserSimulation(
    insufficient,
    simulated,
    runner.lastNetworkReport,
    scenario
  );
  assert.equal(report.status, 'review-required');
  assert.ok(report.checks.some(c => !c.passed));
});

test('browser comparator accepts perfectly matched synthetic inputs without pretending to execute MSE', () => {
  const { browser, one } = prepareScenarios(scenario);
  const runner = new SFVSimulationRunner({
    dataset: one.content.dataset,
    sessions: [
      {
        ruleFactory: () => new SFVCurrentVideoRule(),
        config: { ...one.sessions[0].config, rule: one.sessions[0].abr.config }
      }
    ],
    network: one.network
  });
  const sim = runner.run()[0];
  const fakeBrowser = {
    events: structuredClone(sim.events),
    requests: structuredClone(sim.requests),
    sessionRecord: structuredClone(sim.sessionRecord),
    browserExperiment: { profile: { configuration: browser } },
    compactEventLog: {
      events: runner.lastNetworkReport.events
        .filter(e => e.eventType === 'NETWORK_CAPACITY_CHANGED')
        .map(e => ({ eventType: e.eventType, timestampS: e.time }))
    }
  };
  const report = compareBrowserSimulation(fakeBrowser, sim, runner.lastNetworkReport, scenario);
  assert.equal(report.status, 'timing-checks-passed');
  assert.equal(report.unmatchedRequests.length, 0);
  assert.ok(report.checks.every(c => c.passed));
});

const b2Scenario = JSON.parse(
  fs.readFileSync(new URL('../scenarios/validation/scenario-b2-v1.json', import.meta.url))
);

test('B1 simulation produces exactly one segment-boundary decision per video and fetches media segment 2', () => {
  const { one } = prepareScenarios(scenario);
  const runner = new SFVSimulationRunner({
    dataset: one.content.dataset,
    sessions: [
      {
        ruleFactory: () => new SFVCurrentVideoRule(),
        config: { ...one.sessions[0].config, rule: one.sessions[0].abr.config }
      }
    ],
    network: one.network
  });
  const result = runner.run()[0];
  const boundaries = result.events.filter(e => e.eventType === 'PLAYBACK_POSITION_UPDATED');
  assert.deepEqual(
    boundaries.map(e => e.videoId),
    ['v1', 'v2', 'v3']
  );
  assert.ok(boundaries.every(e => Math.abs(e.positionS - 2) < 1e-8));
  for (const videoId of scenario.playlist) {
    const boundary = boundaries.find(e => e.videoId === videoId);
    const decision = result.events.find(
      e =>
        e.eventType === 'RULE_DECISION' &&
        Math.abs(e.time - boundary.time) < 1e-8 &&
        e.actions?.some(
          a => a.actionType === 'FETCH_MEDIA' && a.videoId === videoId && a.segmentIndex === 2
        )
    );
    assert.ok(decision, `Missing segment 2 decision after ${videoId} playback progress`);
  }
});

test('B2 prepared scenario has identical content, ABR, capacity trace, session timing and user swipes', () => {
  const { browser, one, two } = prepareScenarios(b2Scenario);
  assert.equal(browser.abr.name, 'prefetch');
  assert.deepEqual(browser.abr.config, one.sessions[0].abr.config);
  assert.deepEqual(one.sessions[0].abr, two.sessions[1].abr);
  assert.deepEqual(browser.network.capacityTrace, one.network.capacityTrace);
  assert.deepEqual(one.network, two.network);
  assert.deepEqual(browser.userModel.swipeTimesS, one.sessions[0].config.userModel.swipeTimesS);
  assert.deepEqual(two.sessions[0].config.userModel, two.sessions[1].config.userModel);
});

test('B2 1-UE/2-UE report verifies shared capacity, request symmetry, prefetch budgets and cache reuse', () => {
  const { one, two } = prepareScenarios(b2Scenario);
  const run = spec => {
    const runner = new SFVSimulationRunner({
      dataset: spec.content.dataset,
      network: spec.network,
      sessions: spec.sessions.map(session => ({
        ruleFactory: () => new SFVMultiVideoPrefetchRule(),
        config: { ...session.config, rule: session.abr.config }
      }))
    });
    return { results: runner.run(), network: runner.lastNetworkReport };
  };
  const solo = run(one),
    pair = run(two);
  const report = compareOneTwo(
    solo.results[0],
    pair.results[0],
    pair.results[1],
    solo.network,
    pair.network,
    b2Scenario
  );
  assert.equal(
    report.status,
    'invariants-passed',
    JSON.stringify(report.checks.filter(c => !c.passed))
  );
  assert.equal(report.prefetchComparison.one.futureMediaCompletedBeforeFirstSwipe.length, 4);
  assert.deepEqual(report.prefetchComparison.one.futureMediaCompletedBeforeFirstSwipe, [
    'v2|0',
    'v2|1',
    'v3|0',
    'v3|1'
  ]);
  assert.ok(report.prefetchComparison.one.reusedAfterSwipe.length >= 2);
  assert.ok(report.prefetchComparison.one.reusedAfterSwipe.every(item => !item.redownloaded));
});

test('B2 browser comparator reports missing prefetch rather than calling it parity', () => {
  const { browser, one } = prepareScenarios(b2Scenario);
  const runner = new SFVSimulationRunner({
    dataset: one.content.dataset,
    sessions: [
      {
        ruleFactory: () => new SFVMultiVideoPrefetchRule(),
        config: { ...one.sessions[0].config, rule: one.sessions[0].abr.config }
      }
    ],
    network: one.network
  });
  const sim = runner.run()[0];
  const pseudo = {
    events: structuredClone(sim.events),
    requests: structuredClone(sim.requests),
    sessionRecord: structuredClone(sim.sessionRecord),
    browserExperiment: { profile: { configuration: browser } },
    compactEventLog: {
      events: runner.lastNetworkReport.events
        .filter(e => e.eventType === 'NETWORK_CAPACITY_CHANGED')
        .map(e => ({ eventType: e.eventType, timestampS: e.time }))
    }
  };
  const valid = compareBrowserSimulation(pseudo, sim, runner.lastNetworkReport, b2Scenario);
  assert.equal(valid.status, 'timing-checks-passed');
  assert.ok(valid.prefetchComparison);
  pseudo.requests = pseudo.requests.filter(
    r => !(r.resource?.videoId === 'v3' && r.resource?.resourceType === 'media' && r.startTime < 3)
  );
  const invalid = compareBrowserSimulation(pseudo, sim, runner.lastNetworkReport, b2Scenario);
  assert.equal(invalid.status, 'review-required');
  assert.ok(invalid.checks.some(c => c.label.startsWith('B2 pre-swiped') && !c.passed));
});

const forcedStallScenarios = ['b1', 'b2'].map(algorithm => ({
  algorithm,
  scenario: JSON.parse(
    fs.readFileSync(
      new URL(`../scenarios/validation/scenario-${algorithm}-stalling-v1.json`, import.meta.url)
    )
  )
}));

for (const { algorithm, scenario: forcedScenario } of forcedStallScenarios) {
  test(`${algorithm.toUpperCase()}: forced-capacity-drop scenario produces post-start stalls, recovery and symmetric concurrent UEs`, () => {
    const { browser, one, two } = prepareScenarios(forcedScenario);
    const factory = algorithm === 'b1' ? SFVCurrentVideoRule : SFVMultiVideoPrefetchRule;
    const run = spec => {
      const runner = new SFVSimulationRunner({
        dataset: spec.content.dataset,
        network: spec.network,
        sessions: spec.sessions.map(session => ({
          ruleFactory: () => new factory(),
          config: { ...session.config, rule: session.abr.config }
        }))
      });
      return { results: runner.run(), network: runner.lastNetworkReport };
    };
    const solo = run(one),
      pair = run(two);
    const report = compareOneTwo(
      solo.results[0],
      pair.results[0],
      pair.results[1],
      solo.network,
      pair.network,
      forcedScenario
    );
    assert.equal(
      report.status,
      'invariants-passed',
      JSON.stringify(report.checks.filter(c => !c.passed))
    );
    assert.deepEqual(
      report.stallComparison.one.recovered.map(e => e.videoId),
      ['v1', 'v2']
    );
    assert.ok(
      report.stallComparison.one.recovered.every(
        e => e.durationS >= 0.5 && e.afterPlaybackStarted && e.observedStart && e.observedRecovery
      )
    );
    assert.deepEqual(browser.network.capacityTrace, one.network.capacityTrace);
    assert.deepEqual(browser.userModel.swipeTimesS, one.sessions[0].config.userModel.swipeTimesS);
    const pseudo = {
      events: structuredClone(solo.results[0].events),
      requests: structuredClone(solo.results[0].requests),
      sessionRecord: structuredClone(solo.results[0].sessionRecord),
      browserExperiment: { profile: { configuration: browser } },
      compactEventLog: {
        events: solo.network.events
          .filter(e => e.eventType === 'NETWORK_CAPACITY_CHANGED')
          .map(e => ({ eventType: e.eventType, timestampS: e.time }))
      }
    };
    const identical = compareBrowserSimulation(
      pseudo,
      solo.results[0],
      solo.network,
      forcedScenario
    );
    assert.equal(
      identical.status,
      'timing-checks-passed',
      JSON.stringify(identical.checks.filter(c => !c.passed))
    );
    // A comparator must NOT accept the old false positive: both runtimes can have zero stalls
    // or stale stall summaries with no corresponding playback events.
    pseudo.sessionRecord.playback_metrics.stall_events = [];
    const absent = compareBrowserSimulation(pseudo, solo.results[0], solo.network, forcedScenario);
    assert.equal(absent.status, 'review-required');
    assert.equal(absent.stallComparison.forcedStallValidation.browser.meetsRequiredStalls, false);
    pseudo.sessionRecord.playback_metrics.stall_events = structuredClone(
      solo.results[0].sessionRecord.playback_metrics.stall_events
    );
    pseudo.events = pseudo.events.filter(e => e.eventType !== 'STALL_RECOVERED');
    const noRecovery = compareBrowserSimulation(
      pseudo,
      solo.results[0],
      solo.network,
      forcedScenario
    );
    assert.equal(noRecovery.status, 'review-required');
    assert.equal(
      noRecovery.stallComparison.forcedStallValidation.browser.meetsRequiredStalls,
      false
    );
  });
}

test('scenario titles and artifacts unambiguously name B1 and B2; baselines remain available', () => {
  for (const algorithm of ['b1', 'b2']) {
    for (const variant of ['', '-stalling']) {
      const name = `scenario-${algorithm}${variant}-v1.json`;
      const file = JSON.parse(
        fs.readFileSync(new URL(`../scenarios/validation/${name}`, import.meta.url))
      );
      assert.ok(file.scenarioId.includes(algorithm));
      assert.equal(file.abr.name, algorithm === 'b1' ? 'current' : 'prefetch');
      assert.equal(variant === '-stalling', Boolean(file.stallValidation));
    }
  }
});

test('forced-stalling B1 and B2 have the same network and user conditions with a severe post-start drop', () => {
  const b1 = forcedStallScenarios.find(x => x.algorithm === 'b1').scenario;
  const b2 = forcedStallScenarios.find(x => x.algorithm === 'b2').scenario;
  assert.deepEqual(b1.capacityTrace, b2.capacityTrace);
  assert.deepEqual(b1.swipeTimesS, b2.swipeTimesS);
  assert.equal(b1.sessionDurationS, b2.sessionDurationS);
  assert.deepEqual(b1.playlist, b2.playlist);
  assert.ok(b1.capacityTrace[1][0] <= 1);
  assert.ok(b1.capacityTrace[1][1] <= b1.capacityTrace[0][1] / 100);
  assert.ok(
    b1.capacityTrace.some(([, capacity], index) => index > 1 && capacity >= b1.capacityTrace[0][1])
  );
});
