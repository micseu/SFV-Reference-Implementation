/** Real HTTP transport. Never treats a successful HTTP response as an MSE append. */
export class SFVHttpTransport {
  constructor({
    fetchImpl = globalThis.fetch?.bind(globalThis),
    onEvent = () => {},
    requestTimeoutMs = 0
  } = {}) {
    if (!fetchImpl) throw new Error('fetch unavailable');
    if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs < 0)
      throw new TypeError('Invalid requestTimeoutMs');
    Object.assign(this, { fetchImpl, onEvent, requestTimeoutMs });
    this.controllers = new Map();
  }
  async start(request) {
    const controller = new AbortController();
    let timedOut = false;
    this.controllers.set(request.requestId, controller);
    const timeout =
      this.requestTimeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            controller.abort();
          }, this.requestTimeoutMs)
        : null;
    this.onEvent({
      eventType: 'REQUEST_STARTED',
      time: performance.now() / 1000,
      requestId: request.requestId
    });
    try {
      const response = await this.fetchImpl(request.url, {
        signal: controller.signal,
        cache: 'no-store',
        headers: request.range ? { Range: `bytes=${request.range}` } : undefined
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!response.body) throw new Error('HTTP response body unavailable');
      const expected = response.headers?.get?.('content-length');
      const reader = response.body.getReader();
      let total = 0,
        first = false;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!first) {
          first = true;
          this.onEvent({
            eventType: 'REQUEST_FIRST_BYTE',
            time: performance.now() / 1000,
            requestId: request.requestId
          });
        }
        total += value.byteLength;
        chunks.push(value);
        this.onEvent({
          eventType: 'REQUEST_PROGRESS',
          time: performance.now() / 1000,
          requestId: request.requestId,
          deltaBytes: value.byteLength,
          totalBytes: total
        });
      }
      if (
        expected !== null &&
        expected !== undefined &&
        response.headers?.get?.('content-encoding') === null &&
        Number.isFinite(Number(expected)) &&
        Number(expected) !== total
      ) {
        throw new Error(`HTTP content length mismatch: expected ${expected} bytes, got ${total}`);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const part of chunks) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
      this.onEvent({
        eventType: 'REQUEST_COMPLETED',
        time: performance.now() / 1000,
        requestId: request.requestId,
        totalBytes: total
      });
      return bytes.buffer;
    } catch (error) {
      if (timedOut) {
        this.onEvent({
          eventType: 'REQUEST_FAILED',
          time: performance.now() / 1000,
          requestId: request.requestId,
          error: 'HTTP request timed out'
        });
        throw new Error('HTTP request timed out', { cause: error });
      }
      this.onEvent({
        eventType: controller.signal.aborted ? 'REQUEST_CANCELLED' : 'REQUEST_FAILED',
        time: performance.now() / 1000,
        requestId: request.requestId,
        error: error.message
      });
      throw error;
    } finally {
      if (timeout !== null) clearTimeout(timeout);
      this.controllers.delete(request.requestId);
    }
  }
  abort(requestId) {
    this.controllers.get(requestId)?.abort();
  }
  reset() {
    for (const controller of this.controllers.values()) controller.abort();
    this.controllers.clear();
  }
}
