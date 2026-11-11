/**
 * Deterministic experiment generators. No Math.random, Date, or host clock.
 * A sequence generator consumes values once; a seeded generator can be snapshotted.
 */
export class SFVSequenceGenerator {
  constructor(values) {
    if (!Array.isArray(values)) throw new TypeError('Sequence values must be an array');
    this.values = structuredClone(values);
    this.cursor = 0;
  }
  next() {
    return this.cursor < this.values.length ? structuredClone(this.values[this.cursor++]) : null;
  }
  getState() {
    return { type: 'sequence', cursor: this.cursor, values: structuredClone(this.values) };
  }
  setState(state) {
    if (
      state?.type !== 'sequence' ||
      !Array.isArray(state.values) ||
      !Number.isInteger(state.cursor) ||
      state.cursor < 0 ||
      state.cursor > state.values.length
    ) {
      throw new TypeError('Invalid sequence generator state');
    }
    this.values = structuredClone(state.values);
    this.cursor = state.cursor;
  }
}

export class SFVSeededGenerator {
  constructor(seed = 1) {
    if (!Number.isSafeInteger(seed)) throw new TypeError('Seed must be an integer');
    this.state = seed >>> 0;
  }
  next() {
    // mulberry32: stable unsigned 32-bit integer operations across JS runtimes.
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  between(min, max) {
    if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
      throw new TypeError('Invalid generator range');
    }
    return min + (max - min) * this.next();
  }
  choose(values) {
    if (!Array.isArray(values) || !values.length) throw new TypeError('Empty choices');
    return structuredClone(values[Math.floor(this.next() * values.length)]);
  }
  getState() {
    return { type: 'seeded', state: this.state };
  }
  setState(state) {
    if (
      state?.type !== 'seeded' ||
      !Number.isInteger(state.state) ||
      state.state < 0 ||
      state.state > 0xffffffff
    )
      throw new TypeError('Invalid seeded state');
    this.state = state.state >>> 0;
  }
}

function nonNegativeRange(value, name, positive = false) {
  if (
    !Array.isArray(value) ||
    value.length !== 2 ||
    value.some(v => !Number.isFinite(v) || v < 0) ||
    value[0] > value[1] ||
    (positive && value[0] <= 0)
  )
    throw new TypeError(`${name} must be an increasing non-negative pair`);
  return value;
}

/** Return a fully materialized capacity trace before the simulation begins. */
export function resolveCapacityGenerator(model) {
  if (!model || typeof model !== 'object') throw new TypeError('capacityGenerator is required');
  if (model.type === 'sequence') {
    const sequence = new SFVSequenceGenerator(model.trace);
    const trace = [];
    for (let row = sequence.next(); row !== null; row = sequence.next()) trace.push(row);
    return { trace, metadata: { type: 'sequence', entries: trace.length } };
  }
  if (model.type !== 'seeded')
    throw new TypeError('capacityGenerator type must be sequence or seeded');
  const choices = model.capacityChoicesMbps;
  const duration = nonNegativeRange(model.holdDurationRangeS, 'holdDurationRangeS', true);
  if (
    !Array.isArray(choices) ||
    !choices.length ||
    choices.some(c => !Number.isFinite(c) || c < 0) ||
    !Number.isInteger(model.changes) ||
    model.changes < 0 ||
    model.changes > 100000
  ) {
    throw new TypeError('Invalid seeded capacity generator choices or changes');
  }
  const random = new SFVSeededGenerator(model.seed ?? 1);
  const trace = [[0, random.choose(choices)]];
  let time = 0;
  for (let i = 0; i < model.changes; i += 1) {
    time += random.between(...duration);
    trace.push([time, random.choose(choices)]);
  }
  return {
    trace,
    metadata: {
      type: 'seeded',
      seed: model.seed ?? 1,
      changes: model.changes,
      capacityChoicesMbps: structuredClone(choices),
      holdDurationRangeS: structuredClone(duration)
    }
  };
}

/** Swipes are session-relative, and never generated beyond the session horizon. */
export function resolveUserInteractions(
  model,
  { seed = 1, maxSwipes = 0, horizonS = Infinity } = {}
) {
  if (!model || typeof model !== 'object') throw new TypeError('userModel must be an object');
  if (!Number.isSafeInteger(maxSwipes) || maxSwipes < 0) throw new TypeError('Invalid maxSwipes');
  if (model.type === 'sequence') {
    const source = new SFVSequenceGenerator(model.swipeTimesS ?? []);
    const times = [];
    for (let t = source.next(); t !== null; t = source.next()) times.push(t);
    if (times.some((t, i) => !Number.isFinite(t) || t < 0 || (i && t <= times[i - 1]))) {
      throw new TypeError('Sequence swipe times must be non-negative and strictly increasing');
    }
    return times.filter(t => t < horizonS).slice(0, maxSwipes);
  }
  if (model.type !== 'seeded') throw new TypeError('userModel type must be sequence or seeded');
  const range = nonNegativeRange(model.watchDurationRangeS, 'watchDurationRangeS', true);
  const rng = new SFVSeededGenerator(model.seed ?? seed);
  const times = [];
  let t = 0;
  for (let i = 0; i < maxSwipes; i += 1) {
    t += rng.between(...range);
    if (t >= horizonS) break;
    times.push(t);
  }
  return times;
}
