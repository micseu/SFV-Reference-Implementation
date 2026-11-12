import { REQUEST_STATE } from '../core/constants.js';

const ID = /^[A-Za-z0-9_.-]{1,64}$/;

/** The player-facing transport knows only the generic NetworkBackend contract.
 * Media metadata stays in this registry; only opaque request identifiers and byte
 * counts are returned to the external harness. It never advances global time.
 */
export class SFVExternalTransport {
  constructor({ ue_id, queueAction, now }) {
    if (
      !Number.isSafeInteger(ue_id) ||
      ue_id < 0 ||
      typeof queueAction !== 'function' ||
      typeof now !== 'function'
    ) {
      throw new TypeError('Invalid external transport configuration');
    }
    this.ue_id = ue_id;
    this.queueAction = queueAction;
    this.now = now;
    this.requests = new Map();
    this.used = new Set();
  }

  start(request, now = this.now()) {
    const { requestId, bytesTotal } = request;
    if (
      !ID.test(requestId) ||
      this.used.has(requestId) ||
      !Number.isSafeInteger(bytesTotal) ||
      bytesTotal <= 0
    ) {
      throw new TypeError('Invalid or reused player request ID');
    }
    const entry = {
      ...structuredClone(request),
      state: REQUEST_STATE.ACTIVE,
      startTime: now,
      firstByteTime: null,
      endTime: null,
      bytesDelivered: 0,
      finalBytesDelivered: null,
      abortRequestedAt: null,
      bytesDeliveredAtAbort: null
    };
    this.used.add(requestId);
    this.requests.set(requestId, entry);
    this.queueAction({
      op: 'submit_request',
      ue_id: this.ue_id,
      request_id: requestId,
      bytes_total: bytesTotal
    });
    return structuredClone(entry);
  }

  abort(requestId, now = this.now()) {
    const request = this.requests.get(requestId);
    if (!request || ![REQUEST_STATE.ACTIVE, REQUEST_STATE.CANCELLING].includes(request.state))
      return false;
    if (request.state === REQUEST_STATE.CANCELLING) return true;
    request.state = REQUEST_STATE.CANCELLING;
    request.abortRequestedAt = now;
    request.bytesDeliveredAtAbort = request.bytesDelivered;
    this.queueAction({ op: 'cancel_request', ue_id: this.ue_id, request_id: requestId });
    return true;
  }

  get(requestId) {
    const entry = this.requests.get(requestId);
    return entry ? structuredClone(entry) : null;
  }

  list() {
    return [...this.requests.values()].map(entry => structuredClone(entry));
  }

  /** Apply an event from NetworkStep; completion and cancellation are terminal. */
  receiveEvent(event, dispatch) {
    const { event_type: kind, request_id: requestId, time_s: time } = event;
    const entry = this.requests.get(requestId);
    if (!entry || ![REQUEST_STATE.ACTIVE, REQUEST_STATE.CANCELLING].includes(entry.state)) {
      throw new Error(`Unknown or terminal network request ${requestId}`);
    }
    if (kind === 'DownloadProgress') {
      this.#progress(entry, event.bytes_delivered, time, dispatch);
    } else if (kind === 'DownloadCompleted') {
      this.#progress(entry, entry.bytesTotal, time, dispatch);
      entry.state = REQUEST_STATE.COMPLETED;
      entry.endTime = time;
      entry.finalBytesDelivered = entry.bytesTotal;
      dispatch({ eventType: 'REQUEST_COMPLETED', requestId, time, totalBytes: entry.bytesTotal });
    } else if (kind === 'DownloadCancelled') {
      if (entry.state !== REQUEST_STATE.CANCELLING)
        throw new Error(`Unexpected cancellation of ${requestId}`);
      this.#progress(entry, event.bytes_delivered, time, dispatch);
      entry.state = REQUEST_STATE.CANCELLED;
      entry.endTime = time;
      entry.finalBytesDelivered = event.bytes_delivered;
      dispatch({
        eventType: 'REQUEST_CANCELLED',
        requestId,
        time,
        totalBytes: event.bytes_delivered
      });
    } else {
      throw new Error(`Unsupported request event ${kind}`);
    }
  }

  #progress(entry, amount, time, dispatch) {
    if (
      !Number.isSafeInteger(amount) ||
      amount < entry.bytesDelivered ||
      amount > entry.bytesTotal
    ) {
      throw new Error(`Invalid cumulative bytes for ${entry.requestId}`);
    }
    const delta = amount - entry.bytesDelivered;
    if (delta && entry.firstByteTime === null) {
      entry.firstByteTime = time;
      dispatch({ eventType: 'REQUEST_FIRST_BYTE', requestId: entry.requestId, time });
    }
    entry.bytesDelivered = amount;
    if (delta)
      dispatch({
        eventType: 'REQUEST_PROGRESS',
        requestId: entry.requestId,
        time,
        deltaBytes: delta,
        totalBytes: amount
      });
  }

  finish(time) {
    const events = [];
    for (const entry of this.requests.values()) {
      if (![REQUEST_STATE.ACTIVE, REQUEST_STATE.CANCELLING].includes(entry.state)) continue;
      entry.state = REQUEST_STATE.CANCELLED;
      entry.endTime = time;
      entry.finalBytesDelivered = entry.bytesDelivered;
      events.push({
        eventType: 'REQUEST_CANCELLED',
        requestId: entry.requestId,
        time,
        totalBytes: entry.bytesDelivered
      });
    }
    return events;
  }
}
