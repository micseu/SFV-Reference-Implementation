import { SFVSharedNetworkTransport } from './SFVSharedNetworkTransport.js';

/**
 * Single-UE adapter for the shared capacity/trace transport.
 * Request admission is intentionally NOT implemented here; SFVRequestManager
 * owns the per-UE queue and maxConcurrentRequests setting.
 * Kept under the historical export name for compatibility with v0.3.7.
 */
export class SFVSingleUEQueuedTransport {
  constructor(options = {}) {
    this.backend = new SFVSharedNetworkTransport(options);
    this.ue = this.backend.forUE(0);
  }
  get time() { return this.backend.time; }
  start(request, now) { return this.ue.start(request, now); }
  abort(requestId, now) { return this.ue.abort(requestId, now); }
  get(requestId) { return this.ue.get(requestId); }
  list() { return this.ue.list(); }
  nextEventTime() { return this.backend.nextEventTime(); }
  advanceTo(time) { return this.backend.advanceTo(time).filter(e => e.ueIndex === 0); }
}
