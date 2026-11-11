import fs from 'node:fs';
import path from 'node:path';

export const SFV_EXPERIMENT_SCHEMA_VERSION = 1;

function assertObject(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError(`${name} must be an object`);
}
function assertStringArray(value, name) {
  if (
    value !== undefined &&
    (!Array.isArray(value) || value.some(v => typeof v !== 'string' || !v))
  )
    throw new TypeError(`${name} must be an array of non-empty strings`);
}

export function validateExperimentSpec(spec) {
  assertObject(spec, 'experiment');
  if (spec.schemaVersion !== SFV_EXPERIMENT_SCHEMA_VERSION)
    throw new TypeError(
      `Unsupported experiment schemaVersion ${spec.schemaVersion}; expected ${SFV_EXPERIMENT_SCHEMA_VERSION}`
    );
  if (typeof spec.experimentId !== 'string' || !spec.experimentId)
    throw new TypeError('experimentId is required');
  assertObject(spec.content ?? {}, 'content');
  assertStringArray(spec.content?.videos, 'content.videos');
  assertStringArray(spec.content?.playlist, 'content.playlist');
  if (spec.content?.dataset !== undefined && spec.content?.datasetPath !== undefined)
    throw new TypeError('Specify content.dataset or content.datasetPath, not both');
  if (!Array.isArray(spec.sessions) || !spec.sessions.length)
    throw new TypeError('sessions must be a non-empty array');
  for (const [index, session] of spec.sessions.entries()) {
    assertObject(session, `sessions[${index}]`);
    assertObject(session.abr, `sessions[${index}].abr`);
    if (!['current', 'prefetch'].includes(session.abr.name))
      throw new TypeError(`sessions[${index}].abr.name must be current or prefetch`);
    if (session.abr.config !== undefined)
      assertObject(session.abr.config, `sessions[${index}].abr.config`);
    if (session.config !== undefined) assertObject(session.config, `sessions[${index}].config`);
    const cacheLimit = session.config?.cache?.maxBytes;
    if (cacheLimit !== undefined && (!Number.isSafeInteger(cacheLimit) || cacheLimit < 0)) {
      throw new TypeError(
        `sessions[${index}].config.cache.maxBytes must be a non-negative byte count`
      );
    }
    const retry = session.config?.requestRetry;
    if (retry !== undefined) {
      assertObject(retry, `sessions[${index}].config.requestRetry`);
      if (
        retry.maxRetries !== undefined &&
        (!Number.isSafeInteger(retry.maxRetries) || retry.maxRetries < 0)
      ) {
        throw new TypeError(
          `sessions[${index}].config.requestRetry.maxRetries must be a non-negative integer`
        );
      }
      if (retry.delayS !== undefined && (!Number.isFinite(retry.delayS) || retry.delayS < 0)) {
        throw new TypeError(`sessions[${index}].config.requestRetry.delayS must be non-negative`);
      }
    }
    const timing = session.config?.playbackTiming;
    if (timing !== undefined) {
      assertObject(timing, `sessions[${index}].config.playbackTiming`);
      if (timing.mode === 'causal-simple') {
        const fields = [
          'slotPreparationS',
          'appendProcessingS',
          'startupDelayS',
          'recoveryDelayS',
          'observationIntervalS'
        ];
        for (const field of fields) {
          const value = timing[field];
          if (
            typeof value !== 'number' ||
            !Number.isFinite(value) ||
            value < 0 ||
            value > 1e5 ||
            (field === 'observationIntervalS' && value < 0.001)
          ) {
            throw new TypeError(`Invalid playbackTiming.${field}`);
          }
        }
        for (const field of Object.keys(timing)) {
          if (field !== 'mode' && !fields.includes(field))
            throw new TypeError(`Unknown playbackTiming field ${field}`);
        }
      } else if (timing.mode !== 'browser-platform-trace')
        throw new TypeError('Unsupported playbackTiming mode');
      else {
        assertObject(timing.videos, 'playbackTiming.videos');
        for (const videoId of spec.content?.playlist ?? []) {
          if (!Object.hasOwn(timing.videos, videoId))
            throw new TypeError(`Missing playbackTiming for ${videoId}`);
        }
        for (const [videoId, entry] of Object.entries(timing.videos)) {
          assertObject(entry, `playbackTiming.videos.${videoId}`);
          for (const name of ['slotReadyAtS', 'startupDelayS', 'recoveryDelayS']) {
            if (
              typeof entry[name] !== 'number' ||
              !Number.isFinite(entry[name]) ||
              entry[name] < 0 ||
              entry[name] > 1e5
            ) {
              throw new TypeError(`Invalid playbackTiming.videos.${videoId}.${name}`);
            }
          }
          if (
            !Array.isArray(entry.sampleOffsetsS) ||
            !entry.sampleOffsetsS.length ||
            entry.sampleOffsetsS.some(
              (time, i) =>
                typeof time !== 'number' ||
                !Number.isFinite(time) ||
                time < 0 ||
                time > 1e5 ||
                (i > 0 && time <= entry.sampleOffsetsS[i - 1])
            )
          ) {
            throw new TypeError(`Invalid playbackTiming.videos.${videoId}.sampleOffsetsS`);
          }
        }
      }
    }
    const limit = session.config?.scheduling?.maxConcurrentRequests;
    if (limit !== undefined && limit !== null && (!Number.isSafeInteger(limit) || limit < 1))
      throw new TypeError(
        `sessions[${index}].config.scheduling.maxConcurrentRequests must be a positive integer`
      );
  }
  if (spec.network !== undefined) {
    assertObject(spec.network, 'network');
    if ('maxConcurrentRequests' in spec.network || 'maxConcurrentRequestsPerUE' in spec.network)
      throw new TypeError(
        'Request concurrency is a per-UE scheduling setting, not a network setting'
      );
  }
  return structuredClone(spec);
}

export function loadAndResolveDataset(
  spec,
  { defaultDatasetPath, baseDirectory = process.cwd() } = {}
) {
  const content = spec.content ?? {};
  let dataset;
  let datasetPath = null;
  if (content.dataset !== undefined) {
    dataset = structuredClone(content.dataset);
  } else {
    const selected = content.datasetPath ?? defaultDatasetPath;
    if (!selected) throw new TypeError('No datasetPath or inline dataset provided');
    datasetPath =
      selected instanceof URL ? selected.pathname : path.resolve(baseDirectory, selected);
    dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));
  }
  if (!dataset || !Array.isArray(dataset.videos) || !dataset.videos.length)
    throw new TypeError('Dataset must contain videos[]');
  const all = new Map(dataset.videos.map(v => [v.videoId, v]));
  const allowed = content.videos ?? [...all.keys()];
  for (const id of allowed) if (!all.has(id)) throw new Error(`Unknown content.videos entry ${id}`);
  const playlist = content.playlist ?? allowed;
  if (!playlist.length) throw new TypeError('Resolved playlist must not be empty');
  for (const id of playlist)
    if (!allowed.includes(id) || !all.has(id))
      throw new Error(`Playlist entry ${id} is not in the selected video set`);
  const resolved = {
    ...structuredClone(dataset),
    videos: playlist.map(id => structuredClone(all.get(id)))
  };
  return {
    dataset: resolved,
    datasetPath,
    selectedVideos: structuredClone(allowed),
    playlist: structuredClone(playlist)
  };
}
