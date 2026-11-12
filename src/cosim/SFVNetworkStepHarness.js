import { SFVSimulationController } from '../simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../rules/SFVMultiVideoPrefetchRule.js';
import { SFVExternalTransport } from './SFVExternalTransport.js';

const EPS = 1e-8;
const EVENT_TYPES = new Set(['DownloadProgress', 'DownloadCompleted', 'DownloadCancelled']);

/** Shared-time SFV sessions behind the NetworkBackend API, without FikoRE wire semantics.
 * The external harness supplies a whole NetworkStep and receives opaque network actions only after
 * all UEs have processed the same step. No policy or simulated network is duplicated.
 */
export class SFVNetworkStepHarness {
  constructor({
    dataset,
    sessions,
    timingDefaults = {},
    run_id = 'sfv-network-run',
    signaling_level = 'L0',
    condition = 'unspecified',
    swipe_profile = 'scripted',
    duration_s = 1,
    network_backend
  } = {}) {
    if (
      !dataset?.videos?.length ||
      !Array.isArray(sessions) ||
      !sessions.length ||
      !Number.isFinite(duration_s) ||
      duration_s <= 0
    )
      throw new TypeError('Missing dataset, sessions or duration');
    if (typeof network_backend !== 'string' || !network_backend)
      throw new TypeError('Missing network_backend name');
    this.time = 0;
    this.sequence = -1;
    this.ended = false;
    this.actions = [];
    this.states = new Map();
    this.run_id = run_id;
    this.signaling_level = signaling_level;
    this.duration_s = duration_s;
    this.network_backend = network_backend;
    for (const [index, session] of sessions.entries()) {
      const ue_id = session.ue_id ?? session.config?.ueId ?? index;
      if (!Number.isSafeInteger(ue_id) || ue_id < 0 || this.states.has(ue_id))
        throw new TypeError('Duplicate or invalid UE');
      const behavior =
        session.player_behavior ?? (session.abr?.name === 'prefetch' ? 'preload' : 'simple');
      if (!['simple', 'preload'].includes(behavior))
        throw new TypeError('Unsupported player behavior');
      const Rule = behavior === 'simple' ? SFVCurrentVideoRule : SFVMultiVideoPrefetchRule;
      const transport = new SFVExternalTransport({
        ue_id,
        now: () => this.time,
        queueAction: action => {
          if (!this.ended) this.actions.push(action);
        }
      });
      const config = {
        sessionId: session.config?.sessionId ?? `${run_id}-ue${ue_id}`,
        ueId: ue_id,
        ...timingDefaults,
        ...session.config,
        maxTimeS: duration_s,
        runId: run_id,
        condition,
        signalingLevel: signaling_level,
        swipeProfile: swipe_profile,
        playerBehavior: behavior,
        transport: {
          capacityMbps: null,
          latencyMs: null,
          cancelTailBytes: null,
          cancelTailMs: null,
          network_backend
        },
        networkBackend: network_backend,
        rule: structuredClone(
          session.rule_config ?? session.abr?.config ?? session.config?.rule ?? {}
        )
      };
      const controller = new SFVSimulationController({
        dataset,
        rule: new Rule(),
        config,
        transport,
        requestIdPrefix: `ue${ue_id}-r`
      });
      this.states.set(ue_id, {
        controller,
        transport,
        started: false,
        done: false,
        result: null,
        lastCspKey: undefined
      });
    }
  }

  onStep(step) {
    if (this.ended) throw new Error('Run already finished');
    if (
      !step ||
      !Number.isFinite(step.time_s) ||
      step.time_s < this.time - EPS ||
      step.time_s > this.duration_s + EPS ||
      !Array.isArray(step.events) ||
      typeof step.is_final !== 'boolean'
    )
      throw new TypeError('Invalid NetworkStep');
    if (this.sequence === -1 && Math.abs(step.time_s) > EPS)
      throw new Error('Initial NetworkStep must be t=0');
    if (this.sequence >= 0 && step.time_s <= this.time + EPS)
      throw new Error('NetworkStep time must progress');
    if (step.is_final && Math.abs(step.time_s - this.duration_s) > EPS) {
      throw new Error('Final step does not match experiment duration');
    }
    this.sequence++;
    this.time = step.time_s;
    this.#applyCollaborationSnapshot(step);
    // Advance every UE to the same backend timestamp before applying any network events.
    for (const state of this.states.values()) {
      if (state.started && !state.done) state.controller.advancePlaybackTo(this.time);
    }
    for (const event of step.events) {
      if (
        !event ||
        !EVENT_TYPES.has(event.event_type) ||
        !Number.isSafeInteger(event.ue_id) ||
        !this.states.has(event.ue_id) ||
        !Number.isFinite(event.time_s) ||
        event.time_s > this.time + EPS ||
        event.time_s < 0
      ) {
        throw new TypeError('Invalid NetworkStep event');
      }
      const state = this.states.get(event.ue_id);
      if (!state.started) throw new Error('Network event for unstarted session');
      state.transport.receiveEvent(event, e => state.controller.applyNetworkEvent(e));
    }
    for (const state of this.states.values()) {
      const controller = state.controller;
      if (
        !state.started &&
        !state.done &&
        controller.sessionStartTimeS <= this.time + EPS &&
        controller.sessionStartTimeS < controller.sessionEndTimeS - EPS
      ) {
        controller.startAt(this.time);
        state.started = true;
      }
      if (state.started && !state.done) {
        while (controller.nextSwipeTime() <= this.time + EPS) {
          if (!controller.applySwipeAt(controller.nextSwipeTime()))
            throw new Error('Swipe schedule stalled');
        }
        if (controller.sessionEndTimeS <= this.time + EPS || step.is_final) {
          controller.stopQueuedRequests(this.time, true);
          state.done = true;
        }
      }
    }
    if (!step.is_final) {
      for (const state of this.states.values()) {
        if (!state.started || state.done) continue;
        for (let attempt = 0; attempt < 20; attempt++) {
          state.controller.decideAtEpoch();
          if (!state.controller.hasPendingDecision()) break;
          if (attempt === 19) throw new Error('Decision epoch guard exceeded');
        }
      }
    }
    const actions = this.actions.splice(0);
    if (step.is_final) {
      // No new network operations may be submitted after the last NetworkStep.
      for (const state of this.states.values()) {
        if (state.started) {
          for (const event of state.transport.finish(this.time))
            state.controller.applyNetworkEvent(event);
          state.result = state.controller.finishAt(this.time, true);
        } else state.result = state.controller.finishAt(this.time, false);
      }
      this.ended = true;
      return {
        type: 'player_step_result',
        actions: [],
        result: {
          run_id: this.run_id,
          network_backend: this.network_backend,
          sim_time_s: this.time,
          sessions: [...this.states].map(([ue_id, state]) => ({ ue_id, result: state.result }))
        }
      };
    }
    return { type: 'player_actions', actions };
  }

  #applyCollaborationSnapshot(step) {
    const byUe = step.collaboration?.csp_by_ue;
    if (byUe == null || typeof byUe !== 'object') return;
    for (const [ue_id, state] of this.states) {
      if (state.done) continue;
      const fields = byUe[String(ue_id)] ?? null;
      const key = JSON.stringify(fields);
      if (key === state.lastCspKey) continue;
      state.lastCspKey = key;
      state.controller.applyCspUpdate(fields, this.time);
    }
  }

  /** Pending CAP reports per UE (event-driven, ≤1/s); ``{}`` when nothing changed.
   * After the final step the drain bypasses the rate limit so terminal state is reported. */
  getCapReports() {
    const reports = {};
    for (const [ue_id, state] of this.states) {
      if (!state.started) continue;
      const drained = state.controller.drainCapReports(this.time, { final: this.ended });
      if (drained.length) reports[String(ue_id)] = drained.at(-1);
    }
    return reports;
  }
}
