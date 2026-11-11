import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { buildBrowserReplayInput } from './browser-replay.mjs';
import { runExperiment } from '../run-experiment.mjs';
import { validateExperimentSpec } from '../../src/experiment/SFVExperimentSpec.js';
import { compareBrowserSimulation } from './compare-scenarios.mjs';
import { compareDecisionInputs, replaySessionDecisions } from './abr-diagnostics.mjs';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const json = (directory, name, value) => {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, name), JSON.stringify(value, null, 2) + '\n');
};
const check = (label, passed, detail = {}) => ({ label, passed: passed === true, detail });
const status = checks => (checks.every(x => x.passed) ? 'accepted' : 'review-required');
const key = r =>
  [
    r.resource?.videoId,
    r.resource?.resourceType,
    r.resource?.mediaType ?? '',
    r.resource?.representationId ?? '',
    r.resource?.segmentIndex ?? ''
  ].join('|');
const uniqueSorted = arr => [...new Set(arr)].sort();
const completed = b => (b.requests ?? []).filter(r => r.state === 'COMPLETED');
const firstActiveChoices = b =>
  new Map(
    (b.events ?? [])
      .filter(e => e.eventType === 'ABR_DECISION_DIAGNOSTIC')
      .flatMap(e => {
        const id = e.diagnostic?.context?.currentVideo?.videoId;
        const segment = e.diagnostic?.decision?.actions?.find(
          a => a.actionType === 'FETCH_MEDIA' && a.videoId === id && a.segmentIndex === 0
        );
        return id && segment ? [[id, segment.representationId]] : [];
      })
      .filter(([id], i, array) => array.findIndex(([candidate]) => candidate === id) === i)
  );

/** A prefetched segment may be appended on activation without any new active
 * FETCH_MEDIA decision. The first actually appended segment is the observable
 * quality of that video, rather than a nonexistent second ABR decision. */
export function firstUsedVideoQualities(run, videoIds, { requireAppends = false } = {}) {
  const requested = firstActiveChoices(run);
  return Object.fromEntries(
    videoIds.flatMap(videoId => {
      const appended = (run.events ?? []).find(
        e =>
          e.eventType === 'RESOURCE_APPENDED' &&
          e.videoId === videoId &&
          e.segmentIndex === 0 &&
          e.representationId !== undefined
      );
      if (appended) return [[videoId, String(appended.representationId)]];
      if (!requireAppends && requested.has(videoId))
        return [[videoId, String(requested.get(videoId))]];
      return [];
    })
  );
}

/** Validate an independent DES run: observed user swipes and configured HTTP capacity
 * are inputs, but *no browser playback slot, sample, start/recovery timing, throughput
 * or decisions* enter the simulation. Failed accuracy checks remain measured failures. */
export function independentReplay(
  browser,
  { outputDirectory, sourceSha256 = null, causalTiming = null } = {}
) {
  if (!outputDirectory) throw new TypeError('outputDirectory is required');
  const { spec, scenario } = buildBrowserReplayInput(browser, { useBrowserPlaybackTiming: false });
  if (Object.hasOwn(spec.sessions[0].config, 'playbackTiming'))
    throw new Error('Independent replay must not contain playback timing');
  if (causalTiming) {
    if (causalTiming.mode !== 'causal-simple')
      throw new TypeError('Independent timing must use causal-simple, not browser-platform-trace');
    spec.sessions[0].config.playbackTiming = structuredClone(causalTiming);
    validateExperimentSpec(spec);
  }
  spec.experimentId += '-independent';
  json(outputDirectory, 'independent-experiment.json', spec);
  const simDir = path.join(outputDirectory, 'simulation');
  runExperiment(spec, simDir);
  const sim = JSON.parse(fs.readFileSync(path.join(simDir, 'ue-0-result.json'), 'utf8'));
  const network = JSON.parse(fs.readFileSync(path.join(simDir, 'shared-network.json'), 'utf8'));
  const observational = compareBrowserSimulation(browser, sim, network, scenario);
  const decisionInputs = compareDecisionInputs(browser, sim);
  const bChoices = firstActiveChoices(browser),
    sChoices = firstActiveChoices(sim);
  const ids = spec.content.playlist;
  const choices = ids.map(id => ({
    videoId: id,
    browser: bChoices.get(id) ?? null,
    simulation: sChoices.get(id) ?? null,
    observed: bChoices.has(id) || sChoices.has(id),
    same:
      bChoices.has(id) === sChoices.has(id) &&
      (!bChoices.has(id) || bChoices.get(id) === sChoices.get(id))
  }));
  const tests = [
    check(
      'No recorded browser playback timing supplied',
      spec.sessions[0].config.playbackTiming?.mode !== 'browser-platform-trace'
    ),
    check(
      'Browser original-rule decisions reproduce',
      replaySessionDecisions(browser).status === 'replay-passed'
    ),
    check(
      'Simulation original-rule decisions reproduce',
      replaySessionDecisions(sim).status === 'replay-passed'
    ),
    check(
      'Comparable first-active representation choices match (unobserved prefetch activations marked)',
      choices.some(x => x.observed) &&
        choices.every(x => x.same) &&
        (spec.sessions[0].abr.name !== 'current' || choices.every(x => x.observed)),
      choices
    ),
    ...observational.checks
  ];
  const report = {
    schemaVersion: 1,
    experiment: 'independent-playback-prediction',
    status: status(tests),
    sourceSha256,
    timingModel: causalTiming?.mode ?? 'legacy-virtual-clock',
    inputContract: {
      browserPlaybackTiming: false,
      browserThroughput: false,
      browserChoices: false,
      recordedSwipes: true,
      configuredNetwork: true
    },
    note: 'Same observed user swipes and preconfigured network profile, but no browser playback timing. A failed check is an observed model discrepancy, not a software-test crash. This run alone cannot measure repeatability or cache isolation.',
    checks: tests,
    decisionInputComparison: decisionInputs,
    observationalComparison: observational
  };
  json(outputDirectory, 'independent-report.json', report);
  return report;
}

/** Reject incomparable or duplicate browser runs before estimating repeatability. */
function validateRuns(runs, { minimum = 3, samePage = false } = {}) {
  if (!Array.isArray(runs) || runs.length < minimum)
    throw new TypeError(`At least ${minimum} complete browser exports are required`);
  const signatures = [],
    epochs = [],
    sha = new Set();
  for (const [i, run] of runs.entries()) {
    const cfg = run.browserExperiment?.profile?.configuration;
    const network = run.browserExperiment?.profile?.resolvedNetwork;
    const server = run.browserExperiment?.serverNetwork;
    const epoch = run.browserExperiment?.clockSynchronization?.sessionStartServerTimeS;
    if (
      run.terminationReason !== 'session_end' ||
      run.requestTerminationSettled !== true ||
      run.events?.filter(e => e.eventType === 'SESSION_STARTED').length !== 1 ||
      run.events?.filter(e => e.eventType === 'SESSION_ENDED').length !== 1 ||
      !cfg ||
      !network ||
      !server?.profile ||
      !finite(epoch)
    )
      throw new TypeError(
        `Run ${i + 1} requires a drained full browser export with server-clock evidence`
      );
    const signature = JSON.stringify({ cfg, network, serverProfile: server.profile });
    if (i && signature !== signatures[0])
      throw new TypeError(`Run ${i + 1} has a different experiment or resolved network profile`);
    signatures.push(signature);
    epochs.push(epoch);
    const contentHash = hash(JSON.stringify(run));
    if (sha.has(contentHash)) throw new TypeError(`Run ${i + 1} is a duplicate export`);
    sha.add(contentHash);
    if (i && epoch <= epochs[i - 1])
      throw new TypeError(
        'Browser runs must be distinct and ordered by server-clock session epoch'
      );
    if (
      samePage &&
      (typeof run.browserExperiment.pageInstanceId !== 'string' ||
        run.browserExperiment.pageInstanceId !== runs[0].browserExperiment.pageInstanceId)
    ) {
      throw new TypeError(
        'Same-page cache validation requires the same nonempty pageInstanceId in all runs (browser exports with pageInstanceId)'
      );
    }
  }
  return {
    config: runs[0].browserExperiment.profile.configuration,
    signatureSha256: hash(signatures[0]),
    epochs
  };
}
const series = values => ({
  values,
  min: Math.min(...values),
  max: Math.max(...values),
  range: Math.max(...values) - Math.min(...values),
  mean: values.reduce((a, b) => a + b, 0) / values.length
});
function starts(run, videoId) {
  return (run.events ?? []).find(e => e.eventType === 'PLAYBACK_STARTED' && e.videoId === videoId)
    ?.time;
}
const requestSignature = run => completed(run).map(key).sort();

/** Evaluate at least three *real* same-configuration browser executions. Timing
 * thresholds are defined acceptance criteria, not automatically enlarged to pass. */
export function repeatability(
  runs,
  {
    outputDirectory,
    thresholds = {
      startupRangeS: 0.5,
      perVideoStartRangeS: 0.5,
      swipeRangeS: 0.25,
      requireResourceParity: true,
      requireRepresentationParity: true
    }
  } = {}
) {
  if (!outputDirectory) throw new TypeError('outputDirectory required');
  const { config, signatureSha256, epochs } = validateRuns(runs);
  for (const name of ['startupRangeS', 'perVideoStartRangeS', 'swipeRangeS']) {
    if (!finite(thresholds[name]) || thresholds[name] < 0) throw new TypeError(`Invalid ${name}`);
  }
  const ids = config.playlist.map(p => p.videoId);
  const startup = series(runs.map(r => r.sessionRecord?.session_summary?.initial_playback_delay_s));
  const playback = ids.map(id => ({ videoId: id, stats: series(runs.map(r => starts(r, id))) }));
  const swipes = Array.from({ length: ids.length - 1 }, (_, i) => ({
    index: i,
    stats: series(runs.map(r => (r.events ?? []).filter(e => e.eventType === 'SWIPE')[i]?.time))
  }));
  const requireAppends = config.abr.name === 'prefetch';
  const choices = runs.map(r => firstUsedVideoQualities(r, ids, { requireAppends }));
  const signatures = runs.map(requestSignature);
  const finiteMeasurements = [
    startup,
    ...playback.map(x => x.stats),
    ...swipes.map(x => x.stats)
  ].every(metric => metric.values.every(finite));
  const checks = [
    check('All measured times available and finite', finiteMeasurements),
    check(
      'Initial playback delay range',
      finiteMeasurements && startup.range <= thresholds.startupRangeS,
      startup
    ),
    check(
      'Every video playback-start range',
      finiteMeasurements && playback.every(x => x.stats.range <= thresholds.perVideoStartRangeS),
      playback
    ),
    check(
      'Actual swipe-time ranges',
      finiteMeasurements && swipes.every(x => x.stats.range <= thresholds.swipeRangeS),
      swipes
    ),
    check(
      'Completed logical resources stable',
      !thresholds.requireResourceParity ||
        signatures.every(x => JSON.stringify(x) === JSON.stringify(signatures[0])),
      signatures
    ),
    check(
      'First-used segment-0 representations stable across all playlist videos',
      !thresholds.requireRepresentationParity ||
        (ids.every(id => choices.every(c => Object.hasOwn(c, id))) &&
          choices.every(c => JSON.stringify(c) === JSON.stringify(choices[0]))),
      choices
    )
  ];
  if (requireAppends) {
    // The first segment alone cannot detect a later quality switch. Compare
    // every actually appended (video, segment, representation) occurrence.
    const appended = runs.map(r =>
      ids.map(videoId => ({
        videoId,
        segments: (r.events ?? [])
          .filter(
            e =>
              e.eventType === 'RESOURCE_APPENDED' &&
              e.videoId === videoId &&
              Number.isInteger(e.segmentIndex) &&
              e.representationId !== undefined
          )
          .map(e => `${e.segmentIndex}|${String(e.representationId)}`)
          .sort()
      }))
    );
    checks.push(
      check(
        'All appended segment representations stable for prefetched playback',
        !thresholds.requireRepresentationParity ||
          (appended.every(run => run.every(v => v.segments.length > 0)) &&
            appended.every(run => JSON.stringify(run) === JSON.stringify(appended[0]))),
        appended
      )
    );
  }
  const report = {
    schemaVersion: 1,
    experiment: 'browser-repeatability',
    status: status(checks),
    runCount: runs.length,
    signatureSha256,
    sessionStartServerTimesS: epochs,
    thresholds,
    note: 'Quality uses the first appended segment of each active video and the full multiset of appended segment representations, including cached prefetch; missing B2 append evidence fails. Timing thresholds remain unchanged.',
    checks
  };
  json(outputDirectory, 'repeatability-report.json', report);
  return report;
}

/** Check the second *same-page* session against real emulation-server HTTP events;
 * a browser REQUEST_STARTED alone does not prove an actual server transfer. */
export function cacheIsolation(first, second, { outputDirectory } = {}) {
  if (!outputDirectory) throw new TypeError('outputDirectory required');
  const { config, signatureSha256, epochs } = validateRuns([first, second], {
    minimum: 2,
    samePage: true
  });
  const a = first.browserExperiment.serverNetwork,
    b = second.browserExperiment.serverNetwork;
  const origin = run => new URL(run.requests.find(r => r.resource?.url)?.resource.url).origin;
  const sameServer =
    a.serverInstanceId &&
    a.serverInstanceId === b.serverInstanceId &&
    first.browserExperiment.clockSynchronization.serverInstanceId === a.serverInstanceId &&
    second.browserExperiment.clockSynchronization.serverInstanceId === b.serverInstanceId;
  const startsNew =
    finite(a.startedAtServerS) &&
    finite(b.startedAtServerS) &&
    b.startedAtServerS > a.startedAtServerS;
  const checks = [
    check('Same origin and browser page', origin(first) === origin(second), {
      originFirst: origin(first),
      originSecond: origin(second),
      pageInstanceId: first.browserExperiment.pageInstanceId
    }),
    check('Same HTTP emulator server instance', Boolean(sameServer)),
    check('Fresh, chronologically ordered emulator profile', startsNew, {
      firstStartedAtS: a.startedAtServerS,
      secondStartedAtS: b.startedAtServerS
    })
  ];
  const detail = [];
  for (const [index, run] of [first, second].entries()) {
    const isolation = run.browserExperiment.cacheIsolation;
    checks.push(
      check(
        `Run ${index + 1}: HTTP no-store and clean cache isolation`,
        isolation?.mode === 'http-no-store' &&
          !isolation.error &&
          (!isolation.failures || isolation.failures.length === 0),
        isolation ?? null
      )
    );
    const requests = (run.requests ?? []).filter(r =>
      ['manifest', 'init', 'media'].includes(r.resource?.resourceType)
    );
    const serverEvents = run.browserExperiment.serverNetwork.events ?? [];
    const grouped = entries => {
      const map = new Map();
      for (const [path, bytes] of entries) {
        const id = `${path}|${bytes ?? ''}`;
        map.set(id, (map.get(id) ?? 0) + 1);
      }
      return map;
    };
    const clientStarts = grouped(
      requests.filter(r => finite(r.startTime)).map(r => [new URL(r.resource.url).pathname, null])
    );
    const serverStarts = grouped(
      serverEvents.filter(e => e.eventType === 'HTTP_STARTED').map(e => [e.path, null])
    );
    const clientCompleted = grouped(
      requests
        .filter(r => r.state === 'COMPLETED')
        .map(r => [new URL(r.resource.url).pathname, r.bytesDelivered])
    );
    const serverCompleted = grouped(
      serverEvents
        .filter(e => e.eventType === 'HTTP_COMPLETED')
        .map(e => [e.path, e.deliveredBytes])
    );
    const equals = (x, y) => x.size === y.size && [...x].every(([k, count]) => y.get(k) === count);
    const categories = Object.fromEntries(
      ['manifest', 'init', 'media'].map(type => [
        type,
        requests.filter(r => r.resource.resourceType === type && r.state === 'COMPLETED').length
      ])
    );
    const manifestIds = uniqueSorted(
      requests
        .filter(r => r.resource.resourceType === 'manifest' && r.state === 'COMPLETED')
        .map(r => r.resource.videoId)
    );
    const mediaIds = uniqueSorted(
      requests
        .filter(r => r.resource.resourceType === 'media' && r.state === 'COMPLETED')
        .map(r => r.resource.videoId)
    );
    const initIds = uniqueSorted(
      requests
        .filter(r => r.resource.resourceType === 'init' && r.state === 'COMPLETED')
        .map(r => r.resource.videoId)
    );
    const expectedIds = uniqueSorted(config.playlist.map(p => p.videoId));
    const row = {
      run: index + 1,
      categories,
      clientStarted: requests.filter(r => finite(r.startTime)).length,
      serverStarted: serverEvents.filter(e => e.eventType === 'HTTP_STARTED').length,
      clientCompleted: requests.filter(r => r.state === 'COMPLETED').length,
      serverCompleted: serverEvents.filter(e => e.eventType === 'HTTP_COMPLETED').length,
      manifestIds,
      initIds,
      mediaIds,
      startMatch: equals(clientStarts, serverStarts),
      completionMatch: equals(clientCompleted, serverCompleted)
    };
    detail.push(row);
    checks.push(
      check(
        `Run ${index + 1}: client HTTP starts and server transfers correspond`,
        row.startMatch,
        row
      )
    );
    checks.push(
      check(
        `Run ${index + 1}: completed bytes and resources confirmed at server`,
        row.completionMatch && row.clientCompleted > 0,
        row
      )
    );
    checks.push(
      check(
        `Run ${index + 1}: all playlist videos have fresh manifest, init and media bytes`,
        [manifestIds, initIds, mediaIds].every(
          x => JSON.stringify(x) === JSON.stringify(expectedIds)
        ),
        row
      )
    );
  }
  const report = {
    schemaVersion: 1,
    experiment: 'same-page-session-cache-isolation',
    status: status(checks),
    signatureSha256,
    sessionStartServerTimesS: epochs,
    serverInstanceId: a.serverInstanceId,
    note: 'Both full exports must have the same pageInstanceId; each must show actual HTTP_STARTED and HTTP_COMPLETED for each completed SFV logical transfer. CacheStorage entry deletion is best effort, while HTTP no-store prevents reuse. This does not prove eviction from the global browser cache.',
    runs: detail,
    checks
  };
  json(outputDirectory, 'cache-isolation-report.json', report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [experiment, ...args] = process.argv.slice(2);
  try {
    let result;
    if (
      ['independent', 'independent-causal'].includes(experiment) &&
      args.length === (experiment === 'independent' ? 3 : 4)
    ) {
      const [b1, b2, profileOrOutput, outputForCausal] = args;
      const output = experiment === 'independent' ? profileOrOutput : outputForCausal;
      const causalTiming =
        experiment === 'independent-causal'
          ? JSON.parse(fs.readFileSync(profileOrOutput, 'utf8'))
          : null;
      const cases = [];
      for (const [name, filename] of [
        ['B1', b1],
        ['B2', b2]
      ]) {
        const bytes = fs.readFileSync(filename);
        const browser = JSON.parse(bytes.toString('utf8'));
        if (
          browser.browserExperiment?.profile?.configuration?.abr?.name !==
          (name === 'B1' ? 'current' : 'prefetch')
        )
          throw new TypeError(`Wrong rule in ${name}`);
        const report = independentReplay(browser, {
          outputDirectory: path.join(output, name),
          sourceSha256: hash(bytes),
          causalTiming
        });
        cases.push({
          name,
          status: report.status,
          passed: report.checks.filter(c => c.passed).length,
          total: report.checks.length,
          failures: report.checks.filter(c => !c.passed).map(c => c.label)
        });
      }
      result = {
        schemaVersion: 1,
        experiment: 'independent-playback-prediction',
        timingModel: causalTiming?.mode ?? 'legacy-virtual-clock',
        status: cases.every(c => c.status === 'accepted') ? 'accepted' : 'review-required',
        cases
      };
      json(output, 'independent-summary.json', result);
    } else if (experiment === 'repeatability' && args.length >= 4) {
      const output = args.at(-1);
      result = repeatability(
        args.slice(0, -1).map(f => JSON.parse(fs.readFileSync(f, 'utf8'))),
        { outputDirectory: output }
      );
    } else if (experiment === 'cache' && args.length === 3) {
      result = cacheIsolation(
        ...args.slice(0, 2).map(f => JSON.parse(fs.readFileSync(f, 'utf8'))),
        { outputDirectory: args[2] }
      );
    } else {
      console.error(
        'Usage: supplementary-experiments.mjs independent <B1.json> <B2.json> <out> | independent-causal <B1.json> <B2.json> <timing-profile.json> <out> | repeatability <run1.json> <run2.json> <run3.json> [more.json ...] <out> | cache <first.json> <second.json> <out>'
      );
      process.exitCode = 2;
    }
    if (result) {
      console.log(`${experiment}: ${result.status}`);
      if (result.status !== 'accepted') process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.stack ?? String(error));
    process.exitCode = 1;
  }
}
