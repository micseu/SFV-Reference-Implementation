import { REQUEST_STATE } from '../core/constants.js';

const EPS = 1e-9;

/**
 * One global, work-conserving, equal-per-active-request bottleneck.
 *
 * IMPORTANT: this class models only network capacity. It deliberately does not
 * impose a request-concurrency limit. Admission control belongs to each UE's
 * SFVRequestManager, just like it does in the browser client.
 */
export class SFVSharedNetworkTransport {
  constructor({
    capacityMbps,
    capacityTrace,
    latencyMs = 50,
    cancelTailBytes = 0,
    cancelTailMs = 0,
    faults = []
  } = {}) {
    if (capacityMbps !== undefined && capacityTrace !== undefined) {
      throw new TypeError('Specify capacityMbps or capacityTrace, not both');
    }
    const entries = capacityTrace ?? [[0, capacityMbps ?? 8]];
    if (
      !Array.isArray(entries) ||
      entries.length === 0 ||
      entries.some(
        (entry, index) =>
          !Array.isArray(entry) ||
          entry.length !== 2 ||
          !Number.isFinite(entry[0]) ||
          !Number.isFinite(entry[1]) ||
          entry[0] < 0 ||
          entry[1] < 0 ||
          (index === 0 && entry[0] !== 0) ||
          (index > 0 && entry[0] <= entries[index - 1][0])
      )
    ) {
      throw new TypeError(
        'capacityTrace must be [[timeS, nonNegativeCapacityMbps], ...] with time 0 first and strictly increasing times'
      );
    }
    for (const [name, value] of Object.entries({ latencyMs, cancelTailBytes, cancelTailMs })) {
      if (!Number.isFinite(value) || value < 0)
        throw new TypeError(`${name} must be finite and non-negative`);
    }
    this.trace = entries.map(([timeS, mbps]) => [timeS, mbps]);
    this.latencyS = latencyMs / 1000;
    this.cancelTailBytes = cancelTailBytes;
    this.cancelTailS = cancelTailMs / 1000;
    this.time = 0;
    this.traceIndex = 0;
    this.requests = new Map();
    if (
      !Array.isArray(faults) ||
      faults.some(
        f =>
          !f ||
          typeof f !== 'object' ||
          (f.attempt !== undefined && (!Number.isSafeInteger(f.attempt) || f.attempt < 0))
      )
    )
      throw new TypeError('Invalid network fault trace');
    this.faults = structuredClone(faults);
    this.eventLog = [];
  }

  get capacityMbps() {
    return this.trace[this.traceIndex][1];
  }

  start(request, now, ueId) {
    this.#requireNow(now);
    if (!Number.isInteger(ueId) || ueId < 0)
      throw new TypeError('A non-negative numeric UE index is required');
    if (
      this.requests.has(request.requestId) ||
      !Number.isFinite(request.bytesTotal) ||
      request.bytesTotal <= 0
    ) {
      throw new TypeError('Request ID must be unique and bytesTotal must be positive and finite');
    }
    const fault = this.faults.find(f =>
      ['videoId', 'resourceType', 'representationId', 'segmentIndex', 'attempt'].every(
        k =>
          f[k] === undefined ||
          (k === 'attempt' ? f[k] === (request.retryAttempt ?? 0) : f[k] === request.resource?.[k])
      )
    );
    const r = {
      ...request,
      ueIndex: ueId,
      state: REQUEST_STATE.ACTIVE,
      failure: fault?.reason ?? (fault ? 'INJECTED_FAILURE' : null),
      startTime: now,
      readyAt: now + this.latencyS,
      firstByteTime: null,
      endTime: null,
      remainingBytes: request.bytesTotal,
      bytesDelivered: 0,
      abortRequestedAt: null,
      cancelAt: null,
      bytesDeliveredAtAbort: null,
      finalBytesDelivered: null
    };
    this.requests.set(r.requestId, r);
    this.eventLog.push({
      eventType: 'REQUEST_STARTED',
      time: now,
      requestId: r.requestId,
      ueIndex: ueId
    });
    return structuredClone(r);
  }

  abort(requestId, now) {
    this.#requireNow(now);
    const r = this.requests.get(requestId);
    if (!r || r.state !== REQUEST_STATE.ACTIVE) return false;
    r.state = REQUEST_STATE.CANCELLING;
    r.abortRequestedAt = now;
    r.bytesDeliveredAtAbort = r.bytesDelivered;
    r.cancelAt = now + this.cancelTailS;
    return true;
  }

  nextEventTime() {
    let next =
      this.traceIndex + 1 < this.trace.length ? this.trace[this.traceIndex + 1][0] : Infinity;
    const ready = this.#readyActive();
    for (const r of this.requests.values()) {
      if (r.state === REQUEST_STATE.CANCELLING) next = Math.min(next, r.cancelAt);
      else if (r.state === REQUEST_STATE.ACTIVE && r.readyAt > this.time + EPS)
        next = Math.min(next, r.readyAt);
      else if (
        r.state === REQUEST_STATE.ACTIVE &&
        r.firstByteTime === null &&
        this.capacityMbps > 0
      )
        next = Math.min(next, this.time);
    }
    if (ready.length && this.capacityMbps > 0) {
      const rate = (this.capacityMbps * 1e6) / 8 / ready.length;
      for (const r of ready) next = Math.min(next, this.time + r.remainingBytes / rate);
    }
    return next;
  }

  advanceTo(target) {
    if (!Number.isFinite(target) || target < this.time - EPS)
      throw new Error('Shared transport time reversal or invalid time');
    const events = [];
    this.#settleAt(this.time, events);
    while (this.time < target - EPS) {
      const nextChange =
        this.traceIndex + 1 < this.trace.length ? this.trace[this.traceIndex + 1][0] : Infinity;
      let boundary = Math.min(target, nextChange);
      for (const r of this.requests.values()) {
        if (r.state === REQUEST_STATE.ACTIVE && r.readyAt > this.time + EPS)
          boundary = Math.min(boundary, r.readyAt);
        if (r.state === REQUEST_STATE.CANCELLING) boundary = Math.min(boundary, r.cancelAt);
      }
      const active = this.#readyActive();
      const rate = active.length ? (this.capacityMbps * 1e6) / 8 / active.length : 0;
      if (rate > 0)
        for (const r of active) boundary = Math.min(boundary, this.time + r.remainingBytes / rate);
      if (boundary < this.time - EPS) throw new Error('Invalid shared transport event boundary');
      const dt = Math.max(0, boundary - this.time);
      if (rate > 0 && dt > 0) {
        for (const r of active) {
          const delta = Math.min(r.remainingBytes, rate * dt);
          r.remainingBytes -= delta;
          r.bytesDelivered += delta;
          if (delta > 0)
            events.push({
              eventType: 'REQUEST_PROGRESS',
              time: boundary,
              requestId: r.requestId,
              ueIndex: r.ueIndex,
              deltaBytes: delta,
              totalBytes: r.bytesDelivered
            });
        }
      }
      this.time = boundary;
      this.#settleAt(boundary, events);
      if (dt <= EPS && boundary < target - EPS && this.nextEventTime() <= this.time + EPS) {
        throw new Error('Shared network failed to progress');
      }
    }
    this.time = target;
    this.#settleAt(target, events);
    this.eventLog.push(...events.map(event => structuredClone(event)));
    return events;
  }

  stopUE(ueIndex, now, sessionEnded) {
    this.#requireNow(now);
    const events = [];
    for (const r of this.requests.values()) {
      if (
        r.ueIndex !== ueIndex ||
        ![REQUEST_STATE.ACTIVE, REQUEST_STATE.CANCELLING].includes(r.state)
      )
        continue;
      if (!sessionEnded) {
        r.state = 'OUTSIDE_OBSERVATION';
        r.finalBytesDelivered = r.bytesDelivered;
        continue;
      }
      if (r.abortRequestedAt === null) {
        r.abortRequestedAt = now;
        r.bytesDeliveredAtAbort = r.bytesDelivered;
        events.push({
          eventType: 'REQUEST_ABORT_REQUESTED',
          time: now,
          ueIndex,
          requestId: r.requestId,
          cause: 'SESSION_END'
        });
      }
      r.state = REQUEST_STATE.CANCELLED;
      r.cancelAt = now;
      r.endTime = now;
      r.finalBytesDelivered = r.bytesDelivered;
      events.push({
        eventType: 'REQUEST_CANCELLED',
        time: now,
        ueIndex,
        requestId: r.requestId,
        cause: 'SESSION_END',
        tailBytes: 0
      });
    }
    this.eventLog.push(...events.map(event => structuredClone(event)));
    return events;
  }

  get(requestId) {
    const r = this.requests.get(requestId);
    return r ? structuredClone(r) : null;
  }
  list() {
    return [...this.requests.values()].map(r => structuredClone(r));
  }

  forUE(ueIndex) {
    const backend = this;
    return {
      start: (request, now) => backend.start(request, now, ueIndex),
      abort: (requestId, now) =>
        backend.#owned(ueIndex, requestId) && backend.abort(requestId, now),
      get: requestId => (backend.#owned(ueIndex, requestId) ? backend.get(requestId) : null),
      list: () => backend.list().filter(r => r.ueIndex === ueIndex)
    };
  }

  #owned(ueIndex, requestId) {
    return this.requests.get(requestId)?.ueIndex === ueIndex;
  }
  #requireNow(now) {
    if (!Number.isFinite(now) || Math.abs(now - this.time) > EPS) {
      throw new Error(`Shared transport operation at ${now} while global time is ${this.time}`);
    }
  }
  #readyActive() {
    return [...this.requests.values()].filter(
      r =>
        r.state === REQUEST_STATE.ACTIVE && r.readyAt <= this.time + EPS && r.remainingBytes > EPS
    );
  }
  #settleAt(t, events) {
    while (
      this.traceIndex + 1 < this.trace.length &&
      this.trace[this.traceIndex + 1][0] <= t + EPS
    ) {
      this.traceIndex += 1;
      events.push({
        eventType: 'NETWORK_CAPACITY_CHANGED',
        time: t,
        capacityMbps: this.capacityMbps,
        ueIndex: null
      });
    }
    const ordered = [...this.requests.values()].sort((a, b) =>
      a.requestId.localeCompare(b.requestId)
    );
    for (const r of ordered) {
      if (
        r.state === REQUEST_STATE.ACTIVE &&
        r.readyAt <= t + EPS &&
        r.firstByteTime === null &&
        this.capacityMbps > 0
      ) {
        r.firstByteTime = t;
        events.push({
          eventType: 'REQUEST_FIRST_BYTE',
          time: t,
          requestId: r.requestId,
          ueIndex: r.ueIndex
        });
      }
    }
    for (const r of ordered) {
      if (r.state === REQUEST_STATE.CANCELLING && r.cancelAt <= t + EPS) {
        const tail = Math.min(this.cancelTailBytes, r.remainingBytes);
        r.bytesDelivered += tail;
        r.remainingBytes -= tail;
        r.finalBytesDelivered = r.bytesDelivered;
        r.state = REQUEST_STATE.CANCELLED;
        r.endTime = t;
        events.push({
          eventType: 'REQUEST_CANCELLED',
          time: t,
          requestId: r.requestId,
          ueIndex: r.ueIndex,
          tailBytes: tail
        });
      } else if (
        r.state === REQUEST_STATE.ACTIVE &&
        r.readyAt <= t + EPS &&
        r.remainingBytes <= 1e-5
      ) {
        r.remainingBytes = 0;
        r.finalBytesDelivered = r.bytesDelivered;
        r.state = r.failure ? REQUEST_STATE.FAILED : REQUEST_STATE.COMPLETED;
        r.endTime = t;
        events.push({
          eventType: r.failure ? 'REQUEST_FAILED' : 'REQUEST_COMPLETED',
          time: t,
          requestId: r.requestId,
          ueIndex: r.ueIndex,
          error: r.failure ?? undefined
        });
      }
    }
  }
}
