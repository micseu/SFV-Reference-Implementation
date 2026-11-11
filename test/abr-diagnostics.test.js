import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVAbrController } from '../src/core/SFVAbrController.js';
import { SFVObservationStore } from '../src/core/SFVObservationStore.js';
import { SFVRulesContext } from '../src/core/SFVRulesContext.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import { replayRecordedDecision } from '../src/core/SFVDecisionDiagnostics.js';
import {
  replaySessionDecisions,
  compareDecisionInputs
} from '../scripts/validation/abr-diagnostics.mjs';
import {
  COMPACT_EVENT_SOURCES,
  buildCompactEventLog,
  filterCompactEventLog
} from '../src/output/SFVCompactEventLog.js';
import { validateBrowserExperimentConfig } from '../src/browser/SFVBrowserExperimentConfig.js';
import { prepareScenarios } from '../scripts/validation/prepare-scenarios.mjs';

function setup(Rule, enabled = true) {
  const catalog = {
    videos: ['v1', 'v2', 'v3'].map(videoId => ({ videoId, manifestState: 'UNKNOWN' }))
  };
  const playlist = [{ videoId: 'v1' }, { videoId: 'v2' }, { videoId: 'v3' }];
  const observations = new SFVObservationStore();
  const actions = [];
  const abr = new SFVAbrController({
    rule: new Rule(),
    observationStore: observations,
    decisionDiagnostics: enabled,
    contextFactory: () =>
      new SFVRulesContext({
        time: 0,
        session: { sessionId: 'test-ue' },
        playlist,
        currentVideoIndex: 0,
        catalog,
        store: [],
        requests: [],
        playback: { videoId: 'v1', positionS: 0, bufferedSegments: [], bufferRanges: [] },
        networkHistory: [],
        userHistory: [],
        playbackHistory: []
      }),
    dispatch: a => actions.push(...a)
  });
  abr.reset(
    { activeBufferTargetSegments: 2, max_preload_segments: 4, preload_segments_per_video: 2 },
    47
  );
  abr.observe({ eventType: 'SESSION_STARTED', time: 0, triggerDecision: true });
  abr.decideIfNeeded({ requests: [], store: [], catalogState: () => 'UNKNOWN' });
  return { abr, actions, events: observations.list() };
}

for (const [name, Rule] of [
  ['B1', SFVCurrentVideoRule],
  ['B2', SFVMultiVideoPrefetchRule]
]) {
  test(`${name}: optional diagnostic captures actual pre-batch rule state and replays original rule exactly`, () => {
    const { events, actions } = setup(Rule);
    const diagnosticEvent = events.find(e => e.eventType === 'ABR_DECISION_DIAGNOSTIC');
    assert.ok(diagnosticEvent);
    assert.equal(diagnosticEvent.triggerDecision, false);
    assert.equal(diagnosticEvent.diagnostic.rule, new Rule().name);
    assert.equal(diagnosticEvent.diagnostic.context.currentVideo.videoId, 'v1');
    assert.equal(diagnosticEvent.diagnostic.observations[0].eventType, 'SESSION_STARTED');
    assert.deepEqual(diagnosticEvent.diagnostic.decision.actions, actions);
    assert.equal(replayRecordedDecision(diagnosticEvent.diagnostic, Rule).passed, true);
    assert.equal(replaySessionDecisions({ events }).status, 'replay-passed');
    const tampered = structuredClone(diagnosticEvent.diagnostic);
    tampered.decision.actions = [];
    assert.equal(replayRecordedDecision(tampered, Rule).passed, false);
  });
  test(`${name}: disabled diagnostics do not alter the dispatched action batch`, () => {
    const enabled = setup(Rule, true),
      disabled = setup(Rule, false);
    assert.deepEqual(enabled.actions, disabled.actions);
    assert.equal(
      disabled.events.some(e => e.eventType === 'ABR_DECISION_DIAGNOSTIC'),
      false
    );
  });
}

test('diagnostic comparison reports original evidence boundaries and missing browser snapshots', () => {
  const sim = setup(SFVCurrentVideoRule);
  const incomplete = { events: sim.events.filter(e => e.eventType !== 'ABR_DECISION_DIAGNOSTIC') };
  assert.equal(replaySessionDecisions(incomplete).status, 'missing-diagnostics');
  const report = compareDecisionInputs(incomplete, { events: sim.events });
  assert.equal(report.status, 'review-required');
  assert.equal(report.browserDiagnostics, 0);
});

test('all six UI event sources can be independently filtered while raw compact log stays complete', () => {
  const events = [
    { eventType: 'SESSION_STARTED', time: 0 },
    { eventType: 'REQUEST_STARTED', time: 1 },
    { eventType: 'PLAYBACK_STARTED', time: 2 },
    { eventType: 'ABR_DECISION_DIAGNOSTIC', time: 3, diagnostic: { rule: 'SFVCurrentVideoRule' } },
    { eventType: 'CACHE_ADMISSION_REJECTED', time: 4 },
    { eventType: 'CUSTOM_UNKNOWN', time: 5 }
  ];
  const log = buildCompactEventLog({ events });
  assert.deepEqual(
    log.events.map(e => e.source),
    COMPACT_EVENT_SOURCES
  );
  for (const source of COMPACT_EVENT_SOURCES) {
    const subset = filterCompactEventLog(log, [source]);
    assert.equal(subset.events.length, 1);
    assert.equal(subset.events[0].source, source);
  }
  assert.equal(filterCompactEventLog(log, ['User', 'ABR']).events.length, 2);
  assert.equal(filterCompactEventLog(log, []).events.length, 0);
  assert.equal(log.events.length, 6);
});

test('browser UI exposes individual source toggles; full JSON export remains unfiltered', () => {
  const html = fs.readFileSync(new URL('../web/public/index.html', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../web/public/main.js', import.meta.url), 'utf8');
  for (const source of COMPACT_EVENT_SOURCES)
    assert.match(html, new RegExp(`type="checkbox" value="${source}" checked`));
  assert.match(main, /filterCompactEventLog\(fullLog,\s*enabled\)/);
  assert.match(main, /result\.compactEventLog\s*=\s*compactLog\(result\)/);
  assert.match(main, /lastCompactText\s*=\s*formatCompactEventLog\(fullLog\)/);
});

test('scenario generator preserves original B1 and B2 baseline files and enables common diagnostic option', () => {
  for (const mode of ['b1', 'b2']) {
    const baseline = JSON.parse(
      fs.readFileSync(new URL(`../scenarios/validation/scenario-${mode}-v1.json`, import.meta.url))
    );
    const stalling = JSON.parse(
      fs.readFileSync(
        new URL(`../scenarios/validation/scenario-${mode}-stalling-v1.json`, import.meta.url)
      )
    );
    assert.notDeepEqual(baseline.capacityTrace, stalling.capacityTrace);
    const { browser, one } = prepareScenarios({ ...baseline, diagnostics: { abrDecisions: true } });
    assert.equal(browser.diagnostics.abrDecisions, true);
    assert.equal(one.sessions[0].config.diagnostics.abrDecisions, true);
  }
});

test('browser JSON diagnostic config validation is strict and defaults to off', () => {
  const baseline = JSON.parse(
    fs.readFileSync(new URL('../scenarios/validation/scenario-b1-v1.json', import.meta.url))
  );
  const browser = prepareScenarios(baseline).browser;
  assert.equal(browser.diagnostics.abrDecisions, false);
  assert.throws(
    () => validateBrowserExperimentConfig({ ...browser, diagnostics: { abrDecisions: 'yes' } }),
    /must be boolean/
  );
});
