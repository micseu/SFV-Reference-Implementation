import {
  resolveUserInteractions,
  SFVSeededGenerator
} from '../simulation/generators/SFVGenerators.js';

/** Wall-clock executor for the same session-relative swipe trace used by DES. */
export class SFVBrowserUserAutomation {
  static resolveStartDelay(model, seed = 1) {
    if (model?.sessionStartDelayS !== undefined) {
      if (!Number.isFinite(model.sessionStartDelayS) || model.sessionStartDelayS < 0)
        throw new TypeError('Invalid sessionStartDelayS');
      return model.sessionStartDelayS;
    }
    const window = model?.sessionStartWindowS;
    if (window === undefined) return 0;
    if (
      !Array.isArray(window) ||
      window.length !== 2 ||
      window.some(x => !Number.isFinite(x) || x < 0) ||
      window[0] > window[1]
    ) {
      throw new TypeError('Invalid sessionStartWindowS');
    }
    return new SFVSeededGenerator(model.seed ?? seed).between(...window);
  }
  constructor({
    model,
    playlistLength,
    sessionDurationS = null,
    seed = 1,
    now = () => performance.now() / 1000,
    onSwipe,
    onEnd,
    onObservation = () => {}
  }) {
    if (typeof onSwipe !== 'function' || typeof onEnd !== 'function')
      throw new TypeError('Automation callbacks required');
    if (sessionDurationS !== null && (!Number.isFinite(sessionDurationS) || sessionDurationS < 0))
      throw new TypeError('Invalid session duration');
    this.model = structuredClone(model);
    this.now = now;
    this.onSwipe = onSwipe;
    this.onEnd = onEnd;
    this.onObservation = onObservation;
    this.sessionDurationS = sessionDurationS;
    this.swipeTimesS = resolveUserInteractions(model, {
      seed,
      maxSwipes: Math.max(0, playlistLength - 1),
      horizonS: sessionDurationS ?? Infinity
    });
    this.plannedEvents = [
      ...this.swipeTimesS.map(t => ({ atS: t, action: 'SWIPE_NEXT' })),
      ...(sessionDurationS === null ? [] : [{ atS: sessionDurationS, action: 'SESSION_END' }])
    ].sort((a, b) => a.atS - b.atS);
    this.executedEvents = [];
    this.timers = [];
    this.running = false;
  }
  start() {
    if (this.running) throw new Error('Automation already started');
    this.running = true;
    this.startTimeS = this.now();
    for (const event of this.plannedEvents) {
      const timer = setTimeout(
        () => {
          if (!this.running) return;
          const actualAtS = this.now() - this.startTimeS;
          const result = { ...event, actualAtS, driftS: actualAtS - event.atS };
          this.executedEvents.push(result);
          this.onObservation(result);
          if (event.action === 'SWIPE_NEXT')
            Promise.resolve(this.onSwipe()).catch(error =>
              this.onObservation({
                ...result,
                action: 'AUTOMATION_ERROR',
                error: error.message
              })
            );
          else {
            this.stop();
            this.onEnd();
          }
        },
        Math.max(0, (this.startTimeS + event.atS - this.now()) * 1000)
      );
      this.timers.push(timer);
    }
    return this;
  }
  stop() {
    this.running = false;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers = [];
  }
  snapshot() {
    return {
      model: structuredClone(this.model),
      plannedEvents: structuredClone(this.plannedEvents),
      executedEvents: structuredClone(this.executedEvents)
    };
  }
}
