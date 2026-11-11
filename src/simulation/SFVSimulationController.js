import { SFVVirtualClock } from './SFVVirtualClock.js';
import { SFVConstantRateTransport } from './SFVConstantRateTransport.js';
import { SFVSingleUEQueuedTransport } from './SFVSingleUEQueuedTransport.js';
import { SFVSimulatedPlaybackAgent } from './SFVSimulatedPlaybackAgent.js';
import { SFVRequestManager } from './SFVRequestManager.js';
import { SFVMediaCatalog } from '../media/SFVMediaCatalog.js';
import { SFVSegmentStore } from '../media/SFVSegmentStore.js';
import { cleanupPassedSegments, cleanupDepartedVideo } from '../media/SFVCacheLifecycle.js';
import { SFVObservationStore } from '../core/SFVObservationStore.js';
import { SFVRulesContext } from '../core/SFVRulesContext.js';
import { SFVAbrController } from '../core/SFVAbrController.js';
import { ACTION, MANIFEST_STATE } from '../core/constants.js';
import { SFVSessionRecordBuilder } from '../output/SFVSessionRecordBuilder.js';
import { normalizeSchedulingConfig } from '../core/SFVConfig.js';
import { resolveSessionTiming } from './SFVSessionTiming.js';
import { resolveUserInteractions, resolveCapacityGenerator } from './generators/SFVGenerators.js';
import { cspFieldsEqual, normalizeCspFields } from '../core/SFVCspFields.js';
import { buildCapReportFromSession } from '../core/SFVCapReport.js';

export class SFVSimulationController {
  constructor({ dataset, rule, config = {}, transport = null, requestIdPrefix = 'r' }) {
    const scheduling = normalizeSchedulingConfig(config.scheduling);

    this.config = {
      runId: 'run-1',
      sessionId: 'ue-0',
      ueId: 0,
      seed: 1,
      playerBehavior: rule.name,
      latencyMeasurementSource: 'simulated_playback_started',
      transport: {
        capacityMbps: 8,
        latencyMs: 50,
        cancelTailBytes: 0,
        cancelTailMs: 0,
        ...(config.transport ?? {})
      },
      rule: {},
      ...config,
      scheduling
    };

    // Transport models capacity only. Per-UE concurrency is owned by SFVRequestManager.
    const suppliedTransport = config.transport ?? {};
    if (
      suppliedTransport.capacityGenerator &&
      (suppliedTransport.capacityTrace !== undefined ||
        suppliedTransport.capacityMbps !== undefined)
    ) {
      throw new TypeError(
        'capacityGenerator cannot be combined with capacityMbps or capacityTrace'
      );
    }
    if (suppliedTransport.capacityGenerator) {
      this.config.transportGenerator = structuredClone(suppliedTransport.capacityGenerator);
      this.config.transport.capacityTrace = resolveCapacityGenerator(
        suppliedTransport.capacityGenerator
      ).trace;
      delete this.config.transport.capacityGenerator;
    }
    if (
      this.config.transport.capacityTrace !== undefined &&
      suppliedTransport.capacityMbps === undefined
    ) {
      delete this.config.transport.capacityMbps;
    }
    this.clock = new SFVVirtualClock();
    this.catalog = new SFVMediaCatalog(dataset);
    this.store = new SFVSegmentStore(this.config.cache ?? {});
    this.observations = new SFVObservationStore();
    this.transport =
      transport ??
      (this.config.transport.capacityTrace !== undefined
        ? new SFVSingleUEQueuedTransport(this.config.transport)
        : new SFVConstantRateTransport(this.config.transport));
    this.playback = new SFVSimulatedPlaybackAgent();
    this.playlist = this.catalog.getPlaylist();
    this.currentVideoIndex = 0;
    this.userEvents = [];
    this.playbackEvents = [];
    this.playbackSnapshots = {};
    this.maxTimeS = this.config.maxTimeS ?? 30;
    if (!Number.isFinite(this.maxTimeS) || this.maxTimeS <= 0) {
      throw new TypeError('maxTimeS must be a positive finite experiment cutoff');
    }
    this.sessionTiming = resolveSessionTiming(this.config);
    this.sessionStartTimeS = this.sessionTiming.startTimeS;
    this.sessionEndTimeS = this.sessionTiming.endTimeS;
    // User swipes are relative to this UE's session start, not experiment time zero.
    if (this.config.userModel && this.config.swipeTimesS !== undefined) {
      throw new TypeError('Specify userModel or swipeTimesS, not both');
    }
    const swipeTimes = this.config.userModel
      ? resolveUserInteractions(this.config.userModel, {
          seed: this.config.seed,
          maxSwipes: Math.max(0, this.playlist.length - 1),
          horizonS: Math.min(this.maxTimeS, this.sessionEndTimeS) - this.sessionStartTimeS
        })
      : (this.config.swipeTimesS ?? []);
    if (!Array.isArray(swipeTimes) || swipeTimes.some(t => !Number.isFinite(t) || t < 0)) {
      throw new TypeError('swipeTimesS must contain non-negative session-relative seconds');
    }
    this.config.resolvedSwipeTimesS = structuredClone(swipeTimes);
    this.swipeSchedule = swipeTimes.map(t => this.sessionStartTimeS + t).sort((a, b) => a - b);
    this.nextSwipeIndex = 0;
    this.lastPlaybackDecisionBoundary = 0;
    this.terminationReason = null;
    this.playbackTiming =
      this.config.playbackTiming?.mode === 'browser-platform-trace'
        ? this.config.playbackTiming.videos
        : null;
    this.simpleTiming =
      this.config.playbackTiming?.mode === 'causal-simple' ? this.config.playbackTiming : null;
    this.slotGeneration = 0;
    this.pendingAppends = [];
    this.appendAvailableAt = 0;
    this.sampleNextAt = null;
    this.slotReady = false;
    this.slotReadyAt = Infinity;
    this.sampleOffsets = [];
    this.sampleIndex = 0;
    this.sampleStart = null;
    this.lastObservedPlaybackPosition = 0;
    this.cspFields = null;

    this.requestManager = new SFVRequestManager({
      catalog: this.catalog,
      store: this.store,
      transport: this.transport,
      requestIdPrefix,
      maxConcurrentRequests: this.config.scheduling.maxConcurrentRequests,
      retry: this.config.requestRetry ?? {},
      onEvent: event => this.#onEvent(event)
    });
    this.abr = new SFVAbrController({
      rule,
      observationStore: this.observations,
      requestProgressTriggers: !!this.config.scheduling.requestProgress,
      decisionDiagnostics: this.config.diagnostics?.abrDecisions === true,
      contextFactory: () => this.#context(),
      dispatch: actions => this.#dispatch(actions)
    });
    this.abr.reset(this.config.rule, this.config.seed);
  }

  /** Cooperative API: the shared runner owns global time and all network events. */
  startAt(timeS) {
    if (this.clock.now() !== 0 || timeS < this.sessionStartTimeS - 1e-9) {
      throw new Error('Invalid session start');
    }
    this.clock.advanceTo(timeS);
    this.abr.observe({
      time: timeS,
      eventType: 'SESSION_STARTED',
      scheduling: structuredClone(this.config.scheduling),
      triggerDecision: true
    });
    this.#activateCurrent();
    const event = {
      time: timeS,
      eventType: 'PLAY_REQUESTED',
      videoId: this.playback.videoId,
      cause: 'simulated_session_start',
      triggerDecision: false
    };
    this.playbackEvents.push(event);
    this.abr.observe(event);
  }

  nextPlaybackEventTime() {
    const slot =
      (this.playbackTiming || this.simpleTiming) &&
      !this.slotReady &&
      this.catalog.getManifestState(this.playback.videoId) === MANIFEST_STATE.AVAILABLE
        ? Math.max(this.clock.now(), this.slotReadyAt)
        : Infinity;
    const sample =
      this.sampleStart !== null && this.sampleIndex < this.sampleOffsets.length
        ? this.sampleStart + this.sampleOffsets[this.sampleIndex]
        : Infinity;
    const append = this.pendingAppends.length ? this.pendingAppends[0].at : Infinity;
    return Math.min(
      this.playback.nextEventTime(this.clock.now()),
      slot,
      sample,
      this.sampleNextAt ?? Infinity,
      append
    );
  }

  nextSwipeTime() {
    return this.nextSwipeIndex < this.swipeSchedule.length
      ? this.swipeSchedule[this.nextSwipeIndex]
      : Infinity;
  }

  /** Advance playback using its previous buffer before processing network completions. */
  advancePlaybackTo(timeS) {
    const previousStalled = this.playback.stalled;
    const previousStarted = this.playback.started;
    const previousPosition = this.playback.positionS;
    const previousVideoId = this.playback.videoId;
    const wasCompleted = previousPosition >= this.playback.durationS - 1e-9;
    this.playback.advanceTo(timeS);
    this.clock.advanceTo(timeS);
    if (!previousStarted && this.playback.started) {
      this.#playbackTransition('PLAYBACK_STARTED', timeS);
      this.#beginSampleSchedule(timeS);
    } else if (previousStalled && !this.playback.stalled && previousStarted) {
      this.#playbackTransition('STALL_RECOVERED', timeS);
      if (this.simpleTiming) this.#beginSampleSchedule(timeS);
    }
    if (this.playbackTiming || this.simpleTiming) {
      if (this.simpleTiming && this.sampleNextAt !== null && timeS >= this.sampleNextAt - 1e-8) {
        this.sampleNextAt =
          this.playback.stalled || this.playback.positionS >= this.playback.durationS - 1e-9
            ? null
            : timeS + this.simpleTiming.observationIntervalS;
        if (
          this.playback.started &&
          this.playback.positionS > this.lastObservedPlaybackPosition + 1e-9
        ) {
          this.#playbackPositionSample(timeS, previousVideoId, this.lastObservedPlaybackPosition);
          this.lastObservedPlaybackPosition = this.playback.positionS;
        }
      }
      if (
        this.sampleStart !== null &&
        this.sampleIndex < this.sampleOffsets.length &&
        timeS >= this.sampleStart + this.sampleOffsets[this.sampleIndex] - 1e-8
      ) {
        while (
          this.sampleIndex < this.sampleOffsets.length &&
          timeS >= this.sampleStart + this.sampleOffsets[this.sampleIndex] - 1e-8
        )
          this.sampleIndex++;
        if (this.playback.started && this.playback.positionS > previousPosition + 1e-9) {
          this.#playbackPositionSample(timeS, previousVideoId, this.lastObservedPlaybackPosition);
          this.lastObservedPlaybackPosition = this.playback.positionS;
        }
      }
    } else if (this.playback.started && this.playback.positionS > previousPosition + 1e-9) {
      this.#playbackPositionSample(timeS, previousVideoId, previousPosition);
    }
    this.#markSlotReady(timeS);
    this.#processAppendCompletions(timeS);
    if (!previousStalled && this.playback.stalled) {
      if (this.simpleTiming) this.sampleNextAt = null;
      const event = {
        time: timeS,
        eventType: 'STALL_STARTED',
        videoId: this.playback.videoId,
        triggerDecision: true
      };
      this.playbackEvents.push(event);
      this.abr.observe(event);
    }
    if (!wasCompleted && this.playback.positionS >= this.playback.durationS - 1e-9) {
      if (this.simpleTiming) this.sampleNextAt = null;
      const event = {
        time: timeS,
        eventType: 'VIDEO_COMPLETED',
        videoId: this.playback.videoId,
        triggerDecision: true
      };
      this.playbackEvents.push(event);
      this.abr.observe(event);
    }
  }

  applySwipeAt(timeS) {
    if (Math.abs(this.nextSwipeTime() - timeS) < 1e-8) {
      this.#swipe();
      return true;
    }
    return false;
  }

  applyNetworkEvent(event) {
    this.requestManager.processTransportEvent(event);
  }

  /**
   * Apply a filtered CSP snapshot from pilot ``network_step.collaboration`` (offline harness
   * or future live adapter). Rules read via ``getCspFields()``; policy use is not enabled yet.
   */
  applyCspUpdate(rawFields, timeS) {
    if (!Number.isFinite(timeS) || timeS < 0) throw new TypeError('applyCspUpdate: invalid time_s');
    const next = normalizeCspFields(rawFields);
    const changed = !cspFieldsEqual(this.cspFields, next);
    this.cspFields = next;
    if (!changed) return;
    this.abr.observe({
      time: timeS,
      eventType: 'CSP_TELEMETRY_UPDATED',
      cspFields: next,
      triggerDecision: false
    });
  }

  getCspFields() {
    return this.cspFields == null ? null : structuredClone(this.cspFields);
  }

  /** VQEG ``cap_reports`` payload for one UE at ``timeS`` (pilot co-sim: per network step). */
  buildCapReport(timeS = this.clock.now()) {
    return buildCapReportFromSession({
      timeS,
      playback: this.playback,
      userEvents: this.userEvents
    });
  }

  stopQueuedRequests(timeS, sessionEnded) {
    return this.requestManager.stopQueued(timeS, sessionEnded);
  }

  hasPendingDecision() {
    return !this.#slotBlocked() && this.abr.shouldTrigger(this.abr.pending);
  }

  decideAtEpoch() {
    this.requestManager.processScheduled(this.clock.now());
    this.#markSlotReady(this.clock.now());
    if (this.#slotBlocked()) return null;
    return this.abr.decideIfNeeded(this.#runtimeView());
  }

  finishAt(timeS, started = true) {
    if (timeS < this.clock.now() - 1e-9) throw new Error('Session finish time reversal');
    if (!started) {
      this.clock.advanceTo(timeS);
      this.terminationReason = 'simulation_cutoff';
      this.abr.observe({
        time: timeS,
        eventType: 'SIMULATION_CUTOFF',
        sessionStarted: false,
        triggerDecision: false
      });
      return this.result();
    }
    if (timeS > this.clock.now() + 1e-9) this.advancePlaybackTo(timeS);
    this.terminationReason =
      this.sessionEndTimeS <= this.maxTimeS + 1e-9 && Math.abs(timeS - this.sessionEndTimeS) < 1e-8
        ? 'session_end'
        : 'simulation_cutoff';
    this.abr.observe({
      time: timeS,
      eventType: this.terminationReason === 'session_end' ? 'SESSION_ENDED' : 'SIMULATION_CUTOFF',
      triggerDecision: false
    });
    this.#savePlayback();
    return this.result();
  }

  run() {
    const runEndTime = Math.min(this.maxTimeS, this.sessionEndTimeS);
    if (this.sessionStartTimeS >= runEndTime) {
      // The UE never opens the app during the observation horizon.
      this.clock.advanceTo(runEndTime);
      this.terminationReason = 'simulation_cutoff';
      this.abr.observe({
        time: this.clock.now(),
        eventType: 'SIMULATION_CUTOFF',
        sessionStarted: false,
        triggerDecision: false
      });
      return this.result();
    }
    this.clock.advanceTo(this.sessionStartTimeS);
    // Standalone mode owns both virtual clocks. Synchronize the transport even
    // when a session starts after experiment time zero.
    for (const event of this.transport.advanceTo(this.sessionStartTimeS)) {
      this.requestManager.processTransportEvent(event);
    }
    this.abr.observe({
      time: this.clock.now(),
      eventType: 'SESSION_STARTED',
      scheduling: structuredClone(this.config.scheduling),
      triggerDecision: true
    });
    this.#activateCurrent();
    // Opening the app requests playback at this UE's own start time.
    const playRequest = {
      time: this.clock.now(),
      eventType: 'PLAY_REQUESTED',
      videoId: this.playback.videoId,
      cause: 'simulated_session_start',
      triggerDecision: false
    };
    this.playbackEvents.push(playRequest);
    this.abr.observe(playRequest);
    this.#decide();
    let guard = 0;
    while (this.clock.now() < runEndTime && guard++ < 10000) {
      const now = this.clock.now();
      const networkTime = this.transport.nextEventTime();
      const swipeTime =
        this.nextSwipeIndex < this.swipeSchedule.length
          ? this.swipeSchedule[this.nextSwipeIndex]
          : Infinity;
      const playbackTime = this.nextPlaybackEventTime();
      const next = Math.min(
        networkTime,
        swipeTime,
        playbackTime,
        this.requestManager.nextRetryTime(),
        runEndTime
      );

      if (!Number.isFinite(next)) {
        break;
      }

      if (next <= now + 1e-12) {
        const immediateEvents = [];
        // The shared/trace transport must remain at the same time as the
        // standalone controller before a swipe can abort or admit requests.
        for (const event of this.transport.advanceTo(now)) {
          this.requestManager.processTransportEvent(event);
          immediateEvents.push(event);
        }
        if (Math.abs(swipeTime - now) < 1e-8) {
          immediateEvents.push(...this.#swipe());
        }
        const retries = this.requestManager.processScheduled(now);
        if (!immediateEvents.length && !retries) {
          throw new Error(`Simulation made no time progress at ${now}`);
        }
        this.#decide();
        continue;
      }

      this.advancePlaybackTo(next);
      const epochEvents = [];
      // The shared and standalone paths use exactly the same playback state machine.
      for (const event of this.transport.advanceTo(next)) {
        this.requestManager.processTransportEvent(event);
        epochEvents.push(event);
      }
      if (Math.abs(swipeTime - next) < 1e-8) epochEvents.push(...this.#swipe());

      if (Math.abs(runEndTime - next) < 1e-8) {
        break;
      }
      this.requestManager.processScheduled(this.clock.now());
      this.#decide();
    }

    if (guard >= 10000) {
      throw new Error('Simulation event guard exceeded');
    }

    this.terminationReason =
      this.sessionEndTimeS <= this.maxTimeS + 1e-9 &&
      Math.abs(this.clock.now() - this.sessionEndTimeS) < 1e-8
        ? 'session_end'
        : 'simulation_cutoff';

    const terminationEvent = {
      time: this.clock.now(),
      eventType: this.terminationReason === 'session_end' ? 'SESSION_ENDED' : 'SIMULATION_CUTOFF',
      triggerDecision: false
    };
    this.abr.observe(terminationEvent);

    const finalPosition = this.playback.positionS;
    this.playback.advanceTo(this.clock.now());
    if (this.playback.started && this.playback.positionS > finalPosition + 1e-9) {
      this.#playbackPositionSample(this.clock.now(), this.playback.videoId, finalPosition);
    }
    this.#savePlayback();
    return this.result();
  }

  result() {
    const requests = this.requestManager.list();
    return {
      timeS: this.clock.now(),
      terminationReason: this.terminationReason,
      events: this.observations.list(),
      requests,
      ruleState: this.abr.getState(),
      cache: this.store.stats(),
      sessionRecord: SFVSessionRecordBuilder.build({
        config: this.config,
        sessionTiming: this.sessionTiming,
        dataset: this.catalog.dataset,
        requests,
        userEvents: this.userEvents,
        playbackEvents: this.playbackEvents,
        playbacks: this.playbackSnapshots,
        allEvents: this.observations.list(),
        endTimeS: this.clock.now(),
        terminationReason: this.terminationReason
      })
    };
  }

  #releaseCache(items, reason, time = this.clock.now()) {
    for (const item of items)
      this.abr.observe({
        time,
        eventType: 'CACHE_RESOURCE_RELEASED',
        resource: item.resource,
        bytes: item.bytes,
        reason,
        triggerDecision: false
      });
  }
  #slotBlocked() {
    const blocked =
      !!(this.playbackTiming || this.simpleTiming) &&
      !this.slotReady &&
      this.catalog.getManifestState(this.playback.videoId) === MANIFEST_STATE.AVAILABLE;
    if (blocked && this.simpleTiming && this.slotReadyAt === Infinity) {
      this.slotReadyAt = this.clock.now() + this.simpleTiming.slotPreparationS;
      this.abr.observe({
        time: this.clock.now(),
        eventType: 'PLAYBACK_SLOT_PREPARING',
        videoId: this.playback.videoId,
        triggerDecision: false
      });
    }
    return blocked;
  }

  #markSlotReady(time) {
    if (!this.#slotBlocked() || time < this.slotReadyAt - 1e-8) return;
    this.slotReady = true;
    this.abr.observe({
      time,
      eventType: 'PLAYBACK_SLOT_READY',
      videoId: this.playback.videoId,
      triggerDecision: true
    });
  }

  #playbackTransition(eventType, time) {
    const event = {
      time,
      eventType,
      videoId: this.playback.videoId,
      positionS: this.playback.positionS,
      triggerDecision: true
    };
    this.playbackEvents.push(event);
    this.abr.observe(event);
  }

  #beginSampleSchedule(time) {
    if (this.playbackTiming) {
      this.sampleStart = time;
      this.sampleIndex = 0;
    }
    if (this.simpleTiming) this.sampleNextAt = time + this.simpleTiming.observationIntervalS;
  }

  #playbackPositionSample(time, videoId, previousPosition) {
    // Normalize virtual-time floating point roundoff before constructing the
    // policy context. Without this, a position of 1.9999999999999996 triggers
    // the 2 s boundary but B1 still sees segment 0 as unconsumed and does not
    // request segment 2. The browser sees a position slightly past 2 s.
    const duration = this.playback.segmentDurationS;
    const closest = Math.round(this.playback.positionS / duration) * duration;
    if (Math.abs(this.playback.positionS - closest) <= 1e-8) {
      this.playback.positionS = Math.min(closest, this.playback.durationS);
    }
    const positionS = this.playback.positionS;
    this.#releaseCache(
      cleanupPassedSegments(this.store, { videoId, positionS }),
      'PLAYBACK_CONSUMED',
      time
    );
    const sample = {
      time,
      eventType: 'PLAYBACK_POSITION_SAMPLE',
      videoId,
      positionS,
      triggerDecision: false
    };
    this.playbackEvents.push(sample);
    this.abr.observe(sample);

    // Match the browser's once-per-segment playback-position decision trigger.
    // Segment boundaries are scheduled by the playback agent; use an epsilon
    // for boundaries reached at 1.9999999999999996 in virtual time. A media
    // sample never triggers decisions on its own, and the final video boundary
    // is handled by VIDEO_COMPLETED rather than an extra progress decision.
    const crossed = Math.floor((positionS + 1e-8) / duration);
    const previously = Math.floor((previousPosition + 1e-8) / duration);
    const lastPlayableBoundary = Math.ceil((this.playback.durationS - 1e-8) / duration) - 1;
    if (
      this.playback.started &&
      crossed > previously &&
      crossed > this.lastPlaybackDecisionBoundary &&
      crossed <= lastPlayableBoundary &&
      videoId === this.playback.videoId
    ) {
      this.lastPlaybackDecisionBoundary = crossed;
      const event = {
        time,
        eventType: 'PLAYBACK_POSITION_UPDATED',
        videoId,
        positionS,
        segmentIndex: crossed,
        triggerDecision: true
      };
      this.playbackEvents.push(event);
      this.abr.observe(event);
    }
  }

  #onEvent(event) {
    const observed = this.abr.observe(event);
    if (
      event.eventType === 'RESOURCE_CACHED' &&
      this.playlist
        .slice(0, this.currentVideoIndex)
        .some(item => item.videoId === event.resource?.videoId)
    ) {
      this.#releaseCache(
        cleanupDepartedVideo(this.store, { videoId: event.resource.videoId }),
        'LATE_COMPLETION_FOR_DEPARTED_VIDEO',
        event.time
      );
    }
    return observed;
  }

  #context() {
    return new SFVRulesContext({
      time: this.clock.now(),
      session: { sessionId: this.config.sessionId, ueId: this.config.ueId },
      playlist: this.playlist,
      currentVideoIndex: this.currentVideoIndex,
      catalog: this.catalog.getPolicyView(),
      store: this.store.list(),
      requests: this.requestManager.list(),
      playback: this.playback.snapshot(),
      networkHistory: this.observations
        .list()
        .filter(event => event.eventType.startsWith('REQUEST_')),
      userHistory: this.userEvents,
      playbackHistory: this.playbackEvents,
      cspFields: this.cspFields
    });
  }

  #runtimeView() {
    return {
      requests: this.requestManager.list(),
      store: this.store.list(),
      catalogState: videoId => this.catalog.getManifestState(videoId)
    };
  }

  #decide() {
    if (this.#slotBlocked()) {
      this.#markSlotReady(this.clock.now());
      if (this.#slotBlocked()) return;
    }
    let rounds = 0;
    while (rounds++ < 8) {
      const request = this.abr.decideIfNeeded(this.#runtimeView());
      if (!request || request.actions.length === 0) {
        break;
      }
      const hadImmediateAction =
        !this.simpleTiming && request.actions.some(action => action.actionType === ACTION.APPEND);
      if (!hadImmediateAction) {
        break;
      }
    }
  }

  #dispatch(actions) {
    for (const action of actions) {
      if (action.actionType === ACTION.APPEND) {
        const item = this.store.get({
          resourceType: action.resourceType ?? 'media',
          ...action
        });
        if (!item) {
          continue;
        }

        if (this.simpleTiming) {
          if (
            action.videoId !== this.playback.videoId ||
            this.playback.bufferedSegments.includes(action.segmentIndex) ||
            this.pendingAppends.some(
              p =>
                p.generation === this.slotGeneration &&
                p.action.videoId === action.videoId &&
                p.action.segmentIndex === action.segmentIndex
            )
          )
            continue;
          const at =
            Math.max(this.clock.now(), this.appendAvailableAt) +
            this.simpleTiming.appendProcessingS;
          this.appendAvailableAt = at;
          if (at > this.clock.now() + 1e-9) {
            this.pendingAppends.push({
              at,
              action: structuredClone(action),
              resource: structuredClone(item.resource),
              generation: this.slotGeneration
            });
            this.abr.observe({
              time: this.clock.now(),
              eventType: 'MEDIA_APPEND_PENDING',
              videoId: action.videoId,
              segmentIndex: action.segmentIndex,
              triggerDecision: false
            });
            continue;
          }
        }
        this.#completeAppend(action, item.resource, this.clock.now());
        continue;
      }

      this.requestManager.dispatch(action, this.clock.now());
    }
  }

  #completeAppend(action, resource, time) {
    const result = this.playback.append(resource, action.representationId, time);
    if (!result.appended) return;
    this.abr.observe({
      time,
      eventType: 'RESOURCE_APPENDED',
      videoId: action.videoId,
      segmentIndex: action.segmentIndex,
      representationId: action.representationId,
      triggerDecision: true
    });
    if (result.startedNow) {
      this.#playbackTransition('PLAYBACK_STARTED', time);
      this.#beginSampleSchedule(time);
    } else if (result.recoveredNow) {
      this.#playbackTransition('STALL_RECOVERED', time);
      if (this.simpleTiming) this.#beginSampleSchedule(time);
    }
  }

  #processAppendCompletions(time) {
    while (this.pendingAppends.length && this.pendingAppends[0].at <= time + 1e-8) {
      const pending = this.pendingAppends.shift();
      // A completion from a departed slot must not append into the new video.
      if (
        pending.generation !== this.slotGeneration ||
        pending.action.videoId !== this.playback.videoId
      )
        continue;
      this.#completeAppend(pending.action, pending.resource, time);
    }
  }

  #activateCurrent() {
    this.lastPlaybackDecisionBoundary = 0;
    this.slotGeneration++;
    this.pendingAppends = [];
    this.appendAvailableAt = this.clock.now();
    this.sampleNextAt = null;
    const video = this.catalog.dataset.videos[this.currentVideoIndex];
    const timing = this.playbackTiming?.[video.videoId] ?? {};
    this.slotReady = !(this.playbackTiming || this.simpleTiming);
    this.slotReadyAt = this.playbackTiming
      ? timing.slotReadyAtS + this.sessionStartTimeS
      : Infinity;
    this.sampleOffsets = timing.sampleOffsetsS ?? [];
    this.sampleIndex = 0;
    this.sampleStart = null;
    this.lastObservedPlaybackPosition = 0;
    this.playback.activate(
      video.videoId,
      video.durationS,
      video.segmentDurationS,
      this.clock.now(),
      this.simpleTiming
        ? {
            startupDelayS: this.simpleTiming.startupDelayS,
            recoveryDelayS: this.simpleTiming.recoveryDelayS
          }
        : timing
    );
    this.playbackEvents.push({
      time: this.clock.now(),
      eventType: 'VIDEO_ACTIVATED',
      videoId: video.videoId
    });
  }

  #savePlayback() {
    if (this.playback.videoId) {
      this.playbackSnapshots[this.playback.videoId] = this.playback.snapshot();
    }
  }

  #swipe() {
    if (this.currentVideoIndex >= this.playlist.length - 1) {
      this.nextSwipeIndex += 1;
      return [];
    }

    const now = this.clock.now();
    const fromVideoId = this.playback.videoId;
    this.#savePlayback();
    this.#releaseCache(
      cleanupDepartedVideo(this.store, { videoId: fromVideoId }),
      'VIDEO_DEPARTED'
    );
    this.currentVideoIndex += 1;
    this.nextSwipeIndex += 1;
    const toVideoId = this.playlist[this.currentVideoIndex].videoId;
    const event = {
      time: now,
      eventType: 'SWIPE',
      fromVideoId,
      toVideoId,
      triggerDecision: true
    };
    this.userEvents.push(event);
    this.abr.observe(event);
    const cancellationEvents = this.config.scheduling.swipeCancellation
      ? this.requestManager.cancelPlaybackRequestsForVideo(fromVideoId, now)
      : [];
    this.#activateCurrent();
    return [event, ...cancellationEvents];
  }
}
