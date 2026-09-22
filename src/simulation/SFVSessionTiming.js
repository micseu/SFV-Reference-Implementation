/**
 * Resolve UE-local session lifecycle on the shared experiment clock.
 * Timing randomness is independent of rule and network randomness.
 */
function hash(value) {
  let h = 2166136261;
  for (const ch of String(value)) {
    h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  }
  return h >>> 0;
}

function random01(seed) {
  // Stable 32-bit mixer; no wall clock or Math.random dependency.
  let x = seed >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

function range(value, name, allowZero = true) {
  if (!Array.isArray(value) || value.length !== 2 ||
    value.some(v => !Number.isFinite(v) || v < 0) ||
    value[0] > value[1] || (!allowZero && value[0] <= 0)) {
    throw new TypeError(`${name} must be [non-negative minimum, maximum] in seconds`);
  }
  return value;
}

function positive(value, name, allowZero = false) {
  if (!Number.isFinite(value) || value < 0 || (!allowZero && value === 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} finite number`);
  }
  return value;
}

/**
 * sessionStartTimeS/sessionEndTimeS: absolute seconds on experiment clock.
 * sessionStartWindowS: optional absolute start-time range.
 * sessionDurationS/sessionDurationRangeS: relative to resolved start time.
 * An omitted end means experiment cutoff, not a user session end.
 */
export function resolveSessionTiming(config = {}) {
  const startModes = [config.sessionStartTimeS, config.sessionStartWindowS]
    .filter(v => v !== undefined && v !== null);
  if (startModes.length > 1) {
    throw new TypeError('Choose sessionStartTimeS or sessionStartWindowS, not both');
  }
  const endModes = [config.sessionEndTimeS, config.sessionDurationS, config.sessionDurationRangeS]
    .filter(v => v !== undefined && v !== null);
  if (endModes.length > 1) {
    throw new TypeError('Choose exactly one of sessionEndTimeS, sessionDurationS or sessionDurationRangeS');
  }
  const timingSeed = hash(`${config.seed ?? 1}|${config.ueId ?? 0}|${config.sessionId ?? ''}|session-timing`);
  const startTimeS = config.sessionStartWindowS !== undefined
    ? (() => {
      const [min, max] = range(config.sessionStartWindowS, 'sessionStartWindowS');
      return min + (max - min) * random01(timingSeed);
    })()
    : positive(config.sessionStartTimeS ?? 0, 'sessionStartTimeS', true);
  let endTimeS = Infinity;
  let endMode = 'experiment_cutoff';
  if (config.sessionEndTimeS !== undefined && config.sessionEndTimeS !== null) {
    endTimeS = positive(config.sessionEndTimeS, 'sessionEndTimeS', true);
    endMode = 'absolute_end';
  } else if (config.sessionDurationS !== undefined && config.sessionDurationS !== null) {
    endTimeS = startTimeS + positive(config.sessionDurationS, 'sessionDurationS');
    endMode = 'fixed_duration';
  } else if (config.sessionDurationRangeS !== undefined && config.sessionDurationRangeS !== null) {
    const [min, max] = range(config.sessionDurationRangeS, 'sessionDurationRangeS', false);
    endTimeS = startTimeS + min + (max - min) * random01(timingSeed ^ 0x9e3779b9);
    endMode = 'sampled_duration';
  }
  if (endTimeS <= startTimeS) {
    throw new RangeError('Session end must be strictly after session start');
  }
  return {startTimeS, endTimeS, startMode: config.sessionStartWindowS !== undefined
    ? 'sampled_start' : 'fixed_start', endMode, timingSeed};
}
