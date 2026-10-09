import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validateBrowserExperimentConfig } from '../../src/browser/SFVBrowserExperimentConfig.js';
import { validateExperimentSpec } from '../../src/experiment/SFVExperimentSpec.js';
import { runExperiment } from '../run-experiment.mjs';
import { compareBrowserSimulation } from './compare-scenarios.mjs';
import { compareDecisionInputs, replaySessionDecisions } from './abr-diagnostics.mjs';
import { fixtureAlignedDataset } from './prepare-scenarios.mjs';
import { extractBrowserPlaybackTiming } from '../../src/simulation/SFVBrowserPlaybackTiming.js';

const finite = n => typeof n === 'number' && Number.isFinite(n);
const fail = message => {
  throw new TypeError(`Browser replay input: ${message}`);
};

/** Build a one-UE DES input from a *completed* browser export, using observed swipe times.
 * Do not infer a network trace from throughput measured after the run: use the
 * resolved, explicitly configured HTTP emulator profile that generated the bytes.
 */
export function buildBrowserReplayInput(browser, { useBrowserPlaybackTiming = true } = {}) {
  if (
    !browser ||
    browser.terminationReason !== 'session_end' ||
    browser.requestTerminationSettled !== true ||
    (browser.events ?? []).filter(e => e.eventType === 'SESSION_STARTED').length !== 1 ||
    (browser.events ?? []).filter(e => e.eventType === 'SESSION_ENDED').length !== 1
  ) {
    fail('a completed, drained, full session JSON export is required');
  }
  const profile = browser.browserExperiment?.profile;
  if (!profile?.configuration)
    fail('missing browserExperiment.profile.configuration (export Full Session JSON)');
  const cfg = validateBrowserExperimentConfig(profile.configuration);
  if (browser.browserExperiment?.cacheIsolation?.mode !== 'http-no-store') {
    fail('export lacks cache-isolation evidence; record a browser session with cache diagnostics');
  }
  const network = profile.resolvedNetwork;
  if (
    !network ||
    network.enabled === false ||
    !finite(network.latencyMs) ||
    !(Array.isArray(network.capacityTrace) || finite(network.capacityMbps))
  ) {
    fail('replay needs an enabled, resolved capacity trace or fixed capacity AND latencyMs');
  }
  if (network.faults?.length)
    fail('HTTP path-based fault injection is not portable to DES fault selectors');
  const serverProfile = browser.browserExperiment?.serverNetwork?.profile;
  if (!serverProfile) fail('export lacks the server emulator profile');
  const planned = {
    capacityTrace: network.capacityTrace ?? [[0, network.capacityMbps]],
    latencyMs: network.latencyMs
  };
  if (
    JSON.stringify(serverProfile.capacityTrace ?? [[0, serverProfile.capacityMbps]]) !==
      JSON.stringify(planned.capacityTrace) ||
    serverProfile.latencyMs !== planned.latencyMs
  ) {
    fail('server emulator profile does not match the resolved browser configuration');
  }
  // The standalone simulator resolves the packaged fixtures by videoId. Reject
  // arbitrary browser media so a mismatched dataset cannot silently appear valid.
  for (const item of cfg.playlist) {
    if (!['v1', 'v2', 'v3'].includes(item.videoId)) fail(`unknown fixture video ${item.videoId}`);
    if (item.manifestUrl) {
      const pathname = new URL(item.manifestUrl, 'http://localhost/').pathname;
      if (pathname !== `/media/${item.videoId}/manifest-video-only.mpd`) {
        fail(
          `custom manifest for ${item.videoId} cannot be mapped to the packaged simulator dataset`
        );
      }
    }
  }
  const dataset = fixtureAlignedDataset();
  // A browser can have a valid-looking URL but different bytes (or a stale
  // fixture revision). Require every completed MPD to have the packaged length.
  for (const item of cfg.playlist) {
    const expected = dataset.videos.find(v => v.videoId === item.videoId);
    const manifests = (browser.requests ?? []).filter(
      r =>
        r.resource?.videoId === item.videoId &&
        r.resource.resourceType === 'manifest' &&
        r.state === 'COMPLETED'
    );
    if (
      manifests.length !== 1 ||
      Math.abs(manifests[0].bytesDelivered - expected.manifestBytes) > 1e-6
    ) {
      fail(
        `manifest byte mismatch for ${item.videoId}; browser and DES must use the same video-only MPD`
      );
    }
  }
  let playbackTiming;
  if (useBrowserPlaybackTiming) {
    try {
      playbackTiming = extractBrowserPlaybackTiming(
        browser,
        cfg.playlist.map(item => item.videoId)
      );
    } catch (error) {
      fail(error.message);
    }
  }
  const swipes = (browser.events ?? []).filter(e => e.eventType === 'SWIPE').map(e => e.time);
  const duration = browser.events.findLast(e => e.eventType === 'SESSION_ENDED').time;
  if (
    !finite(duration) ||
    duration <= 0 ||
    swipes.length > cfg.playlist.length - 1 ||
    swipes.some((t, i) => !finite(t) || t < 0 || t >= duration || (i && t <= swipes[i - 1]))
  ) {
    fail('invalid observed swipe times or session end');
  }
  const cache = cfg.cache.maxBytes === null ? {} : { maxBytes: cfg.cache.maxBytes };
  const spec = validateExperimentSpec({
    schemaVersion: 1,
    experimentId: `${cfg.experimentId}-browser-replay`,
    content: { dataset, playlist: cfg.playlist.map(item => item.videoId) },
    network: planned,
    sessions: [
      {
        abr: cfg.abr,
        config: {
          sessionId: 'browser-replay-ue-0',
          ueId: 0,
          seed: cfg.seed,
          maxTimeS: duration + 1,
          sessionStartTimeS: 0,
          sessionDurationS: duration,
          userModel: { type: 'sequence', swipeTimesS: swipes },
          cache,
          ...(playbackTiming ? { playbackTiming } : {}),
          scheduling: cfg.scheduling,
          requestRetry: {
            maxRetries: cfg.requestRetry.maxRetries,
            delayS: cfg.requestRetry.delayMs / 1000
          },
          diagnostics: { abrDecisions: true }
        }
      }
    ]
  });
  const scenario = {
    schemaVersion: 1,
    scenarioId: cfg.experimentId,
    playlist: spec.content.playlist,
    abr: cfg.abr,
    swipeTimesS: swipes,
    sessionDurationS: duration,
    capacityTrace: planned.capacityTrace,
    comparison: {
      userEventToleranceS: 0.05,
      networkEventToleranceS: 0.9,
      requestEventToleranceS: 0.35,
      startupToleranceS: 0.45
    }
  };
  return { spec, scenario };
}

function cfgPlaylistSize(browser) {
  return browser.browserExperiment.profile.configuration.playlist.length;
}
function cfgManifestParity(browser, sim) {
  const manifest = (run, id) =>
    (run.requests ?? []).filter(
      r =>
        r.resource?.resourceType === 'manifest' &&
        r.resource.videoId === id &&
        r.state === 'COMPLETED'
    );
  const ids = browser.browserExperiment.profile.configuration.playlist.map(p => p.videoId);
  return ids.map(id => {
    const b = manifest(browser, id),
      s = manifest(sim, id);
    const pathname = r => new URL(r.resource.url, 'http://localhost/').pathname;
    return {
      videoId: id,
      passed:
        b.length === 1 &&
        s.length === 1 &&
        pathname(b[0]) === pathname(s[0]) &&
        Math.abs(b[0].bytesDelivered - s[0].bytesDelivered) < 1e-6,
      browser: b.map(r => ({ path: pathname(r), bytes: r.bytesDelivered })),
      simulation: s.map(r => ({ path: pathname(r), bytes: r.bytesDelivered }))
    };
  });
}

/** Run DES against recorded browser inputs, replay both runtimes' actual JS ABR
 * decisions, and report every timing/resource mismatch instead of forcing parity.
 */
export function runBrowserReplay(browser, { outputDirectory, sourceSha256 = null } = {}) {
  if (!outputDirectory) throw new TypeError('outputDirectory required');
  const { spec, scenario } = buildBrowserReplayInput(browser);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const write = (filename, value) =>
    fs.writeFileSync(path.join(outputDirectory, filename), JSON.stringify(value, null, 2) + '\n');
  write('replay-experiment.json', spec);
  write('replay-scenario.json', scenario);
  const simDir = path.join(outputDirectory, 'simulation');
  runExperiment(spec, simDir);
  const sim = JSON.parse(fs.readFileSync(path.join(simDir, 'ue-0-result.json'), 'utf8'));
  const network = JSON.parse(fs.readFileSync(path.join(simDir, 'shared-network.json'), 'utf8'));
  const browserDecisions = replaySessionDecisions(browser);
  const simulatedDecisions = replaySessionDecisions(sim);
  const observational = compareBrowserSimulation(browser, sim, network, scenario);
  const inputs = compareDecisionInputs(browser, sim);
  const manifestChecks = cfgManifestParity(browser, sim);
  const choices = inputs.comparisons ?? [];
  const checks = [
    {
      label: 'Recorded browser decisions replay with the original JS rule',
      passed: browserDecisions.status === 'replay-passed',
      detail: browserDecisions
    },
    {
      label: 'Simulated decisions replay with the original JS rule',
      passed: simulatedDecisions.status === 'replay-passed',
      detail: simulatedDecisions
    },
    {
      label: 'Browser and simulator use identical video-only manifest URLs and byte counts',
      passed: manifestChecks.length > 0 && manifestChecks.every(c => c.passed),
      detail: manifestChecks
    },
    {
      label: 'Available first-active-segment ABR choices match',
      passed:
        choices.length > 0 &&
        (browser.browserExperiment.profile.configuration.abr.name !== 'current' ||
          choices.length === cfgPlaylistSize(browser)) &&
        choices.every(c => c.sameRepresentation),
      detail: choices.map(({ videoId, browser: bc, simulation: sc, sameRepresentation }) => ({
        videoId,
        browser: bc?.selectedRepresentationId,
        simulation: sc?.selectedRepresentationId,
        sameRepresentation
      }))
    },
    ...observational.checks
  ];
  const report = {
    schemaVersion: 1,
    comparison: 'recorded-browser-session-vs-des',
    status: checks.every(c => c.passed) ? 'within-configured-tolerances' : 'review-required',
    sourceSha256,
    experimentId: spec.experimentId,
    note: 'Trace-conditioned platform replay: recorded browser slot readiness, post-append playback latencies and timeupdate dispatch offsets are exogenous inputs. DES computes positions, request times, throughput and ABR decisions independently. This is not an independent predictive playback-start test or proof of cross-browser parity.',
    checks,
    browserDecisions,
    simulatedDecisions,
    decisionInputComparison: inputs,
    observationalComparison: observational
  };
  write('browser-replay-report.json', report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [source, outputDirectory] = process.argv.slice(2);
  if (!source || !outputDirectory) {
    console.error(
      'Usage: node scripts/validation/browser-replay.mjs <full-browser-session.json> <output-directory>'
    );
    process.exitCode = 2;
  } else
    try {
      const bytes = fs.readFileSync(source);
      const report = runBrowserReplay(JSON.parse(bytes.toString('utf8')), {
        outputDirectory,
        sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex')
      });
      console.log(
        `Browser replay: ${report.status}; ${report.checks.filter(c => c.passed).length}/${report.checks.length} checks; see ${path.join(outputDirectory, 'browser-replay-report.json')}`
      );
      if (report.status !== 'within-configured-tolerances') process.exitCode = 1;
    } catch (error) {
      console.error(error.stack ?? String(error));
      process.exitCode = 1;
    }
}
