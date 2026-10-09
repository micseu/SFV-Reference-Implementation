/**
 * Deterministic EWMA estimator aligned with dash.js 5.2.x defaults:
 * fast/slow half-lives 3s/8s, weight=0.0015*downloadTimeMs, safety factor 0.9.
 * Samples use application bytes after first byte, mirroring dash.js dead-time latency mode.
 */
export class DashStyleThroughputEstimator {
  constructor(config = {}) {
    this.reset(config);
  }
  reset(config = {}) {
    this.config = {
      fastHalfLifeS: 3,
      slowHalfLifeS: 8,
      weightFactor: 0.0015,
      safetyFactor: 0.9,
      ...config
    };
    this.state = { fastEstimate: 0, slowEstimate: 0, totalWeight: 0, samples: [] };
  }
  addCompletedRequest(req) {
    if (
      req.resource?.resourceType !== 'media' ||
      !Number.isFinite(req.firstByteTime) ||
      !Number.isFinite(req.endTime)
    )
      return;
    const dtMs = Math.max((req.endTime - req.firstByteTime) * 1000, 1);
    const bytes = req.finalBytesDelivered ?? req.bytesDelivered ?? 0;
    if (bytes <= 0) return;
    const value = Math.round((8 * bytes) / dtMs); // kbit/s
    const weight = this.config.weightFactor * dtMs;
    const fastAlpha = Math.pow(0.5, weight / this.config.fastHalfLifeS);
    const slowAlpha = Math.pow(0.5, weight / this.config.slowHalfLifeS);
    this.state.fastEstimate = (1 - fastAlpha) * value + fastAlpha * this.state.fastEstimate;
    this.state.slowEstimate = (1 - slowAlpha) * value + slowAlpha * this.state.slowEstimate;
    this.state.totalWeight += weight;
    this.state.samples.push({ value, downloadTimeMs: dtMs, bytes });
    if (this.state.samples.length > 20) this.state.samples.shift();
  }
  getAverageKbps() {
    const w = this.state.totalWeight;
    if (w <= 0) return NaN;
    const fast = this.state.fastEstimate / (1 - Math.pow(0.5, w / this.config.fastHalfLifeS));
    const slow = this.state.slowEstimate / (1 - Math.pow(0.5, w / this.config.slowHalfLifeS));
    return Math.min(fast, slow);
  }
  getSafeKbps() {
    const x = this.getAverageKbps();
    return Number.isFinite(x) ? x * this.config.safetyFactor : NaN;
  }
  getState() {
    return structuredClone({ config: this.config, state: this.state });
  }
  setState(s) {
    this.config = structuredClone(s.config);
    this.state = structuredClone(s.state);
  }
}
