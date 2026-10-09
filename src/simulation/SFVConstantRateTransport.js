import { REQUEST_STATE } from '../core/constants.js';
export class SFVConstantRateTransport {
  constructor({
    capacityMbps = 8,
    latencyMs = 50,
    cancelTailBytes = 0,
    cancelTailMs = 0,
    faults = []
  } = {}) {
    this.capacityBytesPerS = (capacityMbps * 1e6) / 8;
    this.latencyS = latencyMs / 1000;
    this.cancelTailBytes = cancelTailBytes;
    this.cancelTailS = cancelTailMs / 1000;
    this.time = 0;
    this.requests = new Map();
    this.faults = structuredClone(faults);
  }
  start(request, now) {
    const fault = this.faults.find(f =>
      ['videoId', 'resourceType', 'segmentIndex', 'attempt'].every(
        k =>
          f[k] === undefined ||
          (k === 'attempt' ? f[k] === (request.retryAttempt ?? 0) : f[k] === request.resource?.[k])
      )
    );
    const r = {
      ...request,
      failure: fault?.reason ?? (fault ? 'INJECTED_FAILURE' : null),
      state: REQUEST_STATE.ACTIVE,
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
    return structuredClone(r);
  }
  abort(requestId, now) {
    const r = this.requests.get(requestId);
    if (!r || r.state !== REQUEST_STATE.ACTIVE) return false;
    this.#advanceBytesTo(now);
    this.time = now;
    r.state = REQUEST_STATE.CANCELLING;
    r.abortRequestedAt = now;
    r.bytesDeliveredAtAbort = r.bytesDelivered;
    r.cancelAt = now + this.cancelTailS;
    return true;
  }
  nextEventTime() {
    let next = Infinity;
    for (const r of this.requests.values()) {
      if (r.state === REQUEST_STATE.CANCELLING) {
        next = Math.min(next, r.cancelAt);
        continue;
      }
      if (r.state !== REQUEST_STATE.ACTIVE) continue;
      if (r.readyAt > this.time + 1e-12) {
        next = Math.min(next, r.readyAt);
        continue;
      }
    }
    const active = this.#readyActive();
    if (active.length) {
      const rate = this.capacityBytesPerS / active.length;
      for (const r of active) next = Math.min(next, this.time + r.remainingBytes / rate);
    }
    return next;
  }
  advanceTo(t) {
    if (t < this.time - 1e-9) throw new Error('Transport time reversal');
    const deltas = this.#advanceBytesTo(t);
    const events = [];
    for (const [requestId, delta] of deltas) {
      const r = this.requests.get(requestId);
      if (delta > 0 && r?.state === REQUEST_STATE.ACTIVE)
        events.push({
          eventType: 'REQUEST_PROGRESS',
          time: t,
          requestId,
          deltaBytes: delta,
          totalBytes: r.bytesDelivered
        });
    }
    this.time = t;
    const ready = [...this.requests.values()]
      .filter(
        r =>
          r.state === REQUEST_STATE.ACTIVE &&
          r.firstByteTime === null &&
          Math.abs(r.readyAt - t) < 1e-8
      )
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
    for (const r of ready) {
      r.firstByteTime = t;
      events.push({ eventType: 'REQUEST_FIRST_BYTE', time: t, requestId: r.requestId });
    }
    const cancelling = [...this.requests.values()]
      .filter(r => r.state === REQUEST_STATE.CANCELLING && Math.abs(r.cancelAt - t) < 1e-8)
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
    for (const r of cancelling) {
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
        tailBytes: tail
      });
    }
    const completed = [...this.requests.values()]
      .filter(
        r => r.state === REQUEST_STATE.ACTIVE && r.readyAt <= t + 1e-9 && r.remainingBytes <= 1e-5
      )
      .sort((a, b) => a.requestId.localeCompare(b.requestId));
    for (const r of completed) {
      r.remainingBytes = 0;
      r.finalBytesDelivered = r.bytesDelivered;
      r.state = r.failure ? REQUEST_STATE.FAILED : REQUEST_STATE.COMPLETED;
      r.endTime = t;
      if (r.firstByteTime === null) r.firstByteTime = t;
      events.push({
        eventType: r.failure ? 'REQUEST_FAILED' : 'REQUEST_COMPLETED',
        time: t,
        requestId: r.requestId,
        error: r.failure ?? undefined
      });
    }
    return events;
  }
  get(requestId) {
    const r = this.requests.get(requestId);
    return r ? structuredClone(r) : null;
  }
  list() {
    return [...this.requests.values()].map(x => structuredClone(x));
  }
  #readyActive() {
    return [...this.requests.values()].filter(
      r =>
        r.state === REQUEST_STATE.ACTIVE &&
        r.readyAt <= this.time + 1e-12 &&
        r.remainingBytes > 1e-8
    );
  }
  #advanceBytesTo(t) {
    const dt = t - this.time;
    const deltas = new Map();
    if (dt <= 0) return deltas;
    const active = this.#readyActive();
    if (!active.length) return deltas;
    const rate = this.capacityBytesPerS / active.length;
    for (const r of active) {
      const d = Math.min(r.remainingBytes, rate * dt);
      r.remainingBytes -= d;
      r.bytesDelivered += d;
      deltas.set(r.requestId, d);
    }
    return deltas;
  }
}
