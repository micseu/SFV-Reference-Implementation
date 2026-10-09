import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import {
  validateExperimentSpec,
  loadAndResolveDataset,
  SFV_EXPERIMENT_SCHEMA_VERSION
} from '../src/experiment/SFVExperimentSpec.js';
import { writeCompactEventArtifacts, networkCapacityEvents } from './compact-event-artifacts.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultDatasetPath = path.join(projectRoot, 'fixtures', 'content', 'content.json');

function stableHash(object) {
  return crypto.createHash('sha256').update(JSON.stringify(object)).digest('hex');
}
function readPackageVersion() {
  return JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8')).version;
}

function loadJsonFile(filePath, baseDirectory) {
  const resolved = path.resolve(baseDirectory, filePath);
  return { path: resolved, value: JSON.parse(fs.readFileSync(resolved, 'utf8')) };
}
function resolveTraceFiles(spec, baseDirectory) {
  const resolved = structuredClone(spec);
  if (resolved.network?.capacityTracePath !== undefined) {
    if (
      resolved.network.capacityTrace !== undefined ||
      resolved.network.capacityGenerator !== undefined
    )
      throw new TypeError(
        'capacityTracePath cannot be combined with capacityTrace or capacityGenerator'
      );
    const loaded = loadJsonFile(resolved.network.capacityTracePath, baseDirectory);
    resolved.network.capacityTrace = Array.isArray(loaded.value)
      ? loaded.value
      : loaded.value.trace;
    resolved.network.resolvedCapacityTracePath = loaded.path;
    delete resolved.network.capacityTracePath;
  }
  for (const [index, session] of resolved.sessions.entries()) {
    const model = session.config?.userModel;
    if (model?.tracePath !== undefined) {
      if (model.type !== 'sequence')
        throw new TypeError(`sessions[${index}].config.userModel.tracePath requires type=sequence`);
      if (model.swipeTimesS !== undefined)
        throw new TypeError(
          `sessions[${index}] userModel tracePath cannot be combined with swipeTimesS`
        );
      const loaded = loadJsonFile(model.tracePath, baseDirectory);
      model.swipeTimesS = Array.isArray(loaded.value) ? loaded.value : loaded.value.swipeTimesS;
      model.resolvedTracePath = loaded.path;
      delete model.tracePath;
    }
  }
  return resolved;
}

/** Versioned standalone experiment entry point for command-line and library callers. */
export function runExperiment(inputSpec, outputDirectory, { sourcePath = null } = {}) {
  if (!outputDirectory) throw new TypeError('output directory is required');
  const validated = validateExperimentSpec(inputSpec);
  const baseDirectory = sourcePath ? path.dirname(path.resolve(sourcePath)) : process.cwd();
  const spec = resolveTraceFiles(validated, baseDirectory);
  const content = loadAndResolveDataset(spec, { defaultDatasetPath, baseDirectory });
  const sessions = spec.sessions.map(session => {
    const Rule = session.abr.name === 'current' ? SFVCurrentVideoRule : SFVMultiVideoPrefetchRule;
    const config = {
      ...(session.config ?? {}),
      rule: structuredClone(session.abr.config ?? session.config?.rule ?? {})
    };
    return { ruleFactory: () => new Rule(), config };
  });
  const runner = new SFVSimulationRunner({
    dataset: content.dataset,
    sessions,
    network: spec.network ?? null,
    timingDefaults: spec.timingDefaults ?? {}
  });
  const results = runner.run();
  fs.mkdirSync(outputDirectory, { recursive: true });
  const writeJson = (name, object) =>
    fs.writeFileSync(path.join(outputDirectory, name), JSON.stringify(object, null, 2) + '\n');

  const resolvedSessions = results.map((result, index) => ({
    index,
    sessionId: result.sessionRecord.session_id,
    ueId: result.sessionRecord.ue_id,
    abr: structuredClone(spec.sessions[index].abr),
    scheduling: structuredClone(
      results[index].sessionRecord?.session_timing?.scheduling ??
        sessions[index].config.scheduling ??
        {}
    ),
    resolvedSwipeTimesS: structuredClone(
      result.sessionRecord?.resolved_swipe_times_s ??
        result.events
          .filter(e => e.eventType === 'SWIPE')
          .map(e => e.time - (result.sessionRecord.session_timing.session_started_at_s ?? 0))
    ),
    sessionStartTimeS: result.sessionRecord.session_timing.session_started_at_s,
    sessionEndTimeS: result.sessionRecord.session_timing.session_ended_at_s
  }));
  const resolvedConfig = {
    schemaVersion: SFV_EXPERIMENT_SCHEMA_VERSION,
    experimentId: spec.experimentId,
    content: {
      datasetPath: content.datasetPath,
      selectedVideos: content.selectedVideos,
      playlist: content.playlist
    },
    network: {
      ...(spec.network ?? {}),
      resolvedCapacityTrace: runner.lastNetworkReport.capacityTrace
    },
    timingDefaults: structuredClone(spec.timingDefaults ?? {}),
    sessions: resolvedSessions,
    sourceConfigHash: stableHash(spec)
  };
  const runMetadata = {
    schemaVersion: 1,
    experimentSchemaVersion: SFV_EXPERIMENT_SCHEMA_VERSION,
    experimentId: spec.experimentId,
    sfvVersion: readPackageVersion(),
    nodeVersion: process.version,
    platform: process.platform,
    arch: process.arch,
    sourceConfigHash: resolvedConfig.sourceConfigHash
  };
  writeJson('experiment-config.input.json', spec);
  writeJson('experiment-config.resolved.json', resolvedConfig);
  writeJson('run-metadata.json', runMetadata);
  writeJson('resolved-network-trace.json', {
    trace: runner.lastNetworkReport.capacityTrace,
    generator: spec.network?.capacityGenerator ?? null
  });
  writeJson('resolved-user-events.json', {
    sessions: resolvedSessions.map(s => ({
      sessionId: s.sessionId,
      ueId: s.ueId,
      resolvedSwipeTimesS: s.resolvedSwipeTimesS,
      sessionStartTimeS: s.sessionStartTimeS,
      sessionEndTimeS: s.sessionEndTimeS
    }))
  });
  writeJson('shared-network.json', runner.lastNetworkReport);

  const summary = results.map((result, index) => {
    const prefix = `ue-${index}`;
    const { log } = writeCompactEventArtifacts({
      result,
      outputDirectory,
      prefix,
      networkEvents: networkCapacityEvents(runner.lastNetworkReport, result.timeS)
    });
    result.compactEventLog = log;
    writeJson(`${prefix}-session.json`, result.sessionRecord);
    writeJson(`${prefix}-result.json`, result);
    return {
      ue_index: index,
      session_id: result.sessionRecord.session_id,
      abr: spec.sessions[index].abr.name,
      session_started_at_s: result.sessionRecord.session_timing.session_started_at_s,
      termination_reason: result.terminationReason,
      initial_playback_delay_s: result.sessionRecord.session_summary.initial_playback_delay_s,
      request_count: result.requests.length
    };
  });
  const manifest = {
    schemaVersion: 1,
    experimentId: spec.experimentId,
    status: 'completed',
    files: [
      'experiment-config.input.json',
      'experiment-config.resolved.json',
      'run-metadata.json',
      'resolved-network-trace.json',
      'resolved-user-events.json',
      'shared-network.json',
      'summary.json',
      ...results.flatMap((_, i) => [
        `ue-${i}-session.json`,
        `ue-${i}-result.json`,
        `ue-${i}-compact-events.json`,
        `ue-${i}-compact-events.txt`
      ])
    ]
  };
  writeJson('summary.json', summary);
  writeJson('experiment-manifest.json', manifest);
  return { summary, manifest, resolvedConfig };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [specPath, outputDirectory] = process.argv.slice(2);
  if (!specPath || !outputDirectory) {
    console.error('Usage: node scripts/run-experiment.mjs experiment.json output-directory');
    process.exitCode = 2;
  } else {
    try {
      const spec = JSON.parse(fs.readFileSync(specPath, 'utf8'));
      const result = runExperiment(spec, outputDirectory, { sourcePath: specPath });
      console.log(JSON.stringify(result.summary, null, 2));
    } catch (error) {
      console.error(error.stack ?? String(error));
      process.exitCode = 1;
    }
  }
}
