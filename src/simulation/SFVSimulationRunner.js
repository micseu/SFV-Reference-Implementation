import { SFVSimulationController } from './SFVSimulationController.js';
import { SFVSharedNetworkTransport } from './SFVSharedNetworkTransport.js';
import { resolveCapacityGenerator } from './generators/SFVGenerators.js';

const EPS = 1e-8;

/** One discrete-event experiment, one shared network, independent per-UE state. */
export class SFVSimulationRunner {
  constructor({ dataset, sessions, timingDefaults = {}, network = null }) {
    if (!dataset) throw new Error('dataset is required');
    if (!Array.isArray(sessions) || sessions.length === 0) {
      throw new Error('sessions must be a non-empty array');
    }
    this.dataset = dataset;
    this.sessions = sessions;
    this.timingDefaults = timingDefaults;
    this.networkConfig = network;
    this.lastNetworkReport = null;
  }

  run() {
    const networkConfig = this.networkConfig ?? {
      capacityMbps:
        this.sessions[0].config?.transport?.capacityMbps ??
        this.timingDefaults.transport?.capacityMbps ??
        8,
      latencyMs:
        this.sessions[0].config?.transport?.latencyMs ??
        this.timingDefaults.transport?.latencyMs ??
        50,
      cancelTailBytes: this.sessions[0].config?.transport?.cancelTailBytes ?? 0,
      cancelTailMs: this.sessions[0].config?.transport?.cancelTailMs ?? 0
    };
    if (
      networkConfig.capacityGenerator &&
      (networkConfig.capacityMbps !== undefined || networkConfig.capacityTrace !== undefined)
    ) {
      throw new TypeError(
        'capacityGenerator cannot be combined with capacityMbps or capacityTrace'
      );
    }
    const resolvedNetwork = networkConfig.capacityGenerator
      ? {
          ...networkConfig,
          capacityTrace: resolveCapacityGenerator(networkConfig.capacityGenerator).trace
        }
      : networkConfig;
    delete resolvedNetwork.capacityGenerator;
    const backend = new SFVSharedNetworkTransport(resolvedNetwork);
    const states = this.sessions.map((session, index) => {
      if (typeof session.ruleFactory !== 'function') {
        throw new Error(`sessions[${index}].ruleFactory must be a function`);
      }
      const config = {
        sessionId: session.config?.sessionId ?? `ue-${index}`,
        ueId: session.config?.ueId ?? index,
        ...this.timingDefaults,
        ...session.config,
        networkBackend: 'shared_capacity',
        transportGenerator: networkConfig.capacityGenerator
          ? structuredClone(networkConfig.capacityGenerator)
          : null,
        transport: structuredClone(resolvedNetwork)
      };
      const explicitStart =
        config.sessionStartTimeS !== undefined || config.sessionStartWindowS !== undefined;
      const explicitEnd =
        config.sessionEndTimeS !== undefined ||
        config.sessionDurationS !== undefined ||
        config.sessionDurationRangeS !== undefined;
      if (this.sessions.length > 1 && !explicitStart) {
        config.sessionStartWindowS = [0, Math.min(5, (config.maxTimeS ?? 30) * 0.2)];
      }
      if (this.sessions.length > 1 && !explicitEnd) {
        const horizon = config.maxTimeS ?? 30;
        config.sessionDurationRangeS = [horizon * 0.35, horizon * 0.6];
      }
      const controller = new SFVSimulationController({
        dataset: this.dataset,
        rule: session.ruleFactory(),
        config,
        transport: backend.forUE(index),
        requestIdPrefix: `ue${index}-r`
      });
      return {
        controller,
        started: false,
        done: false,
        result: null,
        endS: Math.min(controller.maxTimeS, controller.sessionEndTimeS)
      };
    });
    // The global network and every UE run on one strictly monotonic experiment clock.
    let iterations = 0;
    while (states.some(state => !state.done)) {
      if (++iterations > 100000) throw new Error('Global simulation event guard exceeded');
      let next = Infinity;
      for (const state of states) {
        if (state.done) continue;
        const c = state.controller;
        next = Math.min(next, state.endS);
        if (!state.started) {
          if (c.sessionStartTimeS < state.endS - EPS) next = Math.min(next, c.sessionStartTimeS);
        } else {
          next = Math.min(
            next,
            c.nextSwipeTime(),
            c.nextPlaybackEventTime(),
            c.requestManager.nextRetryTime()
          );
        }
      }
      // Immediate APPEND observations cause a fresh logical micro-epoch at the
      // same timestamp, not a second rule call inside the current epoch.
      if (states.some(s => s.started && !s.done && s.controller.hasPendingDecision())) {
        next = Math.min(next, backend.time);
      }
      const earliestActiveEnd = Math.max(...states.filter(s => !s.done).map(s => s.endS));
      next = Math.min(next, backend.nextEventTime(), earliestActiveEnd);
      if (!Number.isFinite(next) || next < backend.time - EPS) {
        throw new Error(`Invalid global event time ${next}`);
      }
      // Playback advances using buffer contents as of the start of this epoch.
      for (const state of states) {
        if (state.started && !state.done) state.controller.advancePlaybackTo(next);
      }
      // Network progress and completions at the same timestamp are processed before
      // a swipe/session end. All UE policies run only after all state transitions.
      const networkEvents = backend.advanceTo(next);
      for (const event of networkEvents) {
        if (event.ueIndex !== null && event.ueIndex !== undefined) {
          states[event.ueIndex].controller.applyNetworkEvent(event);
        }
      }
      for (const state of states) {
        if (state.done || state.started) continue;
        if (
          state.controller.sessionStartTimeS <= next + EPS &&
          state.controller.sessionStartTimeS < state.endS - EPS
        ) {
          state.controller.startAt(next);
          state.started = true;
        }
      }
      for (const state of states) {
        if (state.started && !state.done && state.endS > next + EPS) {
          state.controller.applySwipeAt(next);
        }
      }
      for (const [index, state] of states.entries()) {
        if (!state.done && state.endS <= next + EPS) {
          const ended =
            state.controller.sessionEndTimeS <= state.controller.maxTimeS + EPS &&
            Math.abs(state.endS - state.controller.sessionEndTimeS) <= EPS &&
            state.started;
          // Include terminal cancellation in a real session end's accounting.
          state.controller.stopQueuedRequests(next, ended);
          if (ended) {
            for (const event of backend.stopUE(index, next, true)) {
              state.controller.applyNetworkEvent(event);
            }
          }
          state.result = state.controller.finishAt(next, state.started);
          // A cutoff is observational, not a cancellation. Stop allocating
          // experiment bandwidth after taking the per-UE output snapshot.
          if (!ended) backend.stopUE(index, next, false);
          state.done = true;
        }
      }
      for (const state of states) {
        if (state.started && !state.done) state.controller.decideAtEpoch();
      }
    }
    this.lastNetworkReport = {
      model: 'shared_capacity_equal_per_request',
      capacityTrace: backend.trace.map(entry => [...entry]),
      events: structuredClone(backend.eventLog),
      requests: backend.list(),
      concurrency: {
        scope: 'per_ue',
        sessions: states.map((state, index) => ({
          ue_index: index,
          maxConcurrentRequests: Number.isFinite(
            state.controller.config.scheduling.maxConcurrentRequests
          )
            ? state.controller.config.scheduling.maxConcurrentRequests
            : null
        }))
      },
      capacityGenerator: networkConfig.capacityGenerator
        ? structuredClone(networkConfig.capacityGenerator)
        : null,
      simulatedUntilS: backend.time
    };
    return states.map(state => state.result);
  }
}
