import { SFVBrowserMediaCatalog } from './SFVBrowserMediaCatalog.js';
import { SFVDashAssetResolver } from './SFVDashAssetResolver.js';
import { SFVBrowserRequestManager } from './SFVBrowserRequestManager.js';
import { SFVPlayerPool } from './SFVPlayerPool.js';
import { SFVDashBrowserBridge } from './SFVDashBrowserBridge.js';
import { SFVPlaybackAgent } from './SFVPlaybackAgent.js';
import { SFVHttpTransport } from './SFVHttpTransport.js';
import { SFVSegmentStore } from '../media/SFVSegmentStore.js';
import { cleanupPassedSegments, cleanupDepartedVideo } from '../media/SFVCacheLifecycle.js';
import { SFVObservationStore } from '../core/SFVObservationStore.js';
import { SFVRulesContext } from '../core/SFVRulesContext.js';
import { SFVAbrController } from '../core/SFVAbrController.js';
import { normalizeSchedulingConfig } from '../core/SFVConfig.js';
import { ACTION, MANIFEST_STATE } from '../core/constants.js';
import { SFVSessionRecordBuilder } from '../output/SFVSessionRecordBuilder.js';

/** One browser feed/UE; B1 and B2 run unmodified against the same rules context as DES. */
export class SFVBrowserController {
  constructor({
    dashjs,
    parseDashManifest,
    videoElement,
    playlist,
    rule,
    config = {},
    transport = null,
    now = () => performance.now() / 1000,
    onError = console.error,
    onAutoplayBlocked = () => {}
  }) {
    if (!rule || !Array.isArray(playlist) || !playlist.length)
      throw new TypeError('Rule and playlist required');
    this.now = now;
    this.epochStart = now();
    this.onError = onError;
    this.onAutoplayBlocked = onAutoplayBlocked;
    this.config = {
      runId: 'browser-run',
      sessionId: 'browser-ue-0',
      ueId: 0,
      seed: 1,
      rule: {},
      playerBehavior: rule.name,
      networkBackend: 'real_http',
      latencyMeasurementSource: 'html_media_element_playing',
      ...config,
      scheduling: normalizeSchedulingConfig(config.scheduling)
    };
    this.catalog = new SFVBrowserMediaCatalog(playlist);
    this.catalog.resolver = new SFVDashAssetResolver({ parseDashManifest });
    this.playlist = this.catalog.getPlaylist();
    this.currentVideoIndex = 0;
    this.store = new SFVSegmentStore(config.cache ?? {});
    this.observations = new SFVObservationStore();
    this.networkEvents = [];
    this.userEvents = [];
    this.playbackEvents = [];
    this.playbacks = {};
    this.playback = new SFVPlaybackAgent(videoElement);
    this.playback.activate(playlist[0].videoId);
    this.pool = new SFVPlayerPool({
      dashjs,
      videoElement,
      onEvent: e => this.#observe(e),
      now: () => this.time()
    });
    this.bridge = new SFVDashBrowserBridge({
      catalog: this.catalog,
      store: this.store,
      pool: this.pool,
      playback: this.playback,
      onEvent: e => this.#observe(e),
      now: () => this.time()
    });
    this.transport =
      transport ??
      new SFVHttpTransport({ requestTimeoutMs: this.config.http?.requestTimeoutMs ?? 0 });
    this.requestManager = new SFVBrowserRequestManager({
      catalog: this.catalog,
      store: this.store,
      transport: this.transport,
      resolveRequest: r => this.pool.resolve(r),
      now: () => this.time(),
      maxConcurrentRequests: this.config.scheduling.maxConcurrentRequests ?? Infinity,
      retry: this.config.requestRetry ?? {},
      onEvent: e => this.#observe(e)
    });
    this.abr = new SFVAbrController({
      rule,
      observationStore: this.observations,
      requestProgressTriggers: this.config.scheduling.requestProgress,
      decisionDiagnostics: this.config.diagnostics?.abrDecisions === true,
      contextFactory: () => this.#context(),
      dispatch: actions => this.#dispatch(actions)
    });
    this.abr.reset(this.config.rule, this.config.seed);
    this.draining = false;
    this.scheduled = false;
    this.scheduleTimer = null;
    this.stopped = false;
    this.started = false;
    this.ending = false;
    this.activeSlotPromise = null;
    this.activeSlotVideoId = null;
    this.lastPlaybackSegment = -1;
    this.stallStart = null;
    this.videoElement = videoElement;
    this.startedVideos = new Set();
    this.autoPlayAttempted = new Set();
    this.lastSamplePosition = null;
    this.lastSampleVideoId = null;
    this.seekPending = false;
    this.listeners = [];
    this.#bindPlaybackEvents();
  }
  time() {
    return this.now() - this.epochStart;
  }
  #observe(event) {
    if (this.stopped) return;
    const e = this.abr.observe({ ...event, time: event.time ?? this.time() });
    if (
      e.eventType === 'RESOURCE_CACHED' &&
      this.playlist
        .slice(0, this.currentVideoIndex)
        .some(item => item.videoId === e.resource?.videoId)
    ) {
      this.#cacheReleased(
        cleanupDepartedVideo(this.store, { videoId: e.resource.videoId }),
        'LATE_COMPLETION_FOR_DEPARTED_VIDEO'
      );
    }
    if (e.eventType.startsWith('REQUEST_')) this.networkEvents.push(e);
    if (e.eventType === 'RESOURCE_APPENDED' && this.started && !this.stopped) {
      this.#tryAutomaticPlayback(e.videoId);
    }
    if (e.eventType === 'SWIPE') this.userEvents.push(e);
    if (
      [
        'VIDEO_ACTIVATED',
        'PLAY_REQUESTED',
        'PLAY_REQUEST_FAILED',
        'PLAYBACK_STARTED',
        'STALL_STARTED',
        'STALL_RECOVERED',
        'STALL_ENDED',
        'VIDEO_COMPLETED',
        'PLAYBACK_POSITION_SAMPLE'
      ].includes(e.eventType)
    ) {
      this.playbackEvents.push(e);
    }
    // Record progress always; trigger a decision only when configured.
    if (
      e.triggerDecision !== false &&
      (e.eventType !== 'REQUEST_PROGRESS' || this.config.scheduling.requestProgress)
    )
      this.#schedule();
  }
  #schedule() {
    if (this.scheduled || this.stopped || this.ending) return;
    this.scheduled = true;
    // Yield to browser/MSE/HTTP tasks instead of chaining policy microtasks.
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      this.scheduled = false;
      if (!this.stopped) this.#drain().catch(error => this.onError(error));
    }, 0);
  }
  #context() {
    const playback = this.playback.snapshot();
    playback.pendingAppendSegments = [...this.bridge.appendPending].map(key => {
      const items = key.split('|');
      return Number(items.at(-1));
    });
    return new SFVRulesContext({
      time: this.time(),
      session: { sessionId: this.config.sessionId, ueId: this.config.ueId },
      playlist: this.playlist,
      currentVideoIndex: this.currentVideoIndex,
      catalog: this.catalog.getPolicyView(),
      store: this.store.list(),
      requests: this.requestManager.list(),
      playback,
      // Avoid cloning the entire append-only history on every decision epoch.
      // SFVRulesContext.getNetworkHistory() still clones when the rule requests it.
      networkHistory: this.networkEvents,
      userHistory: this.userEvents,
      playbackHistory: this.playbackEvents
    });
  }
  #runtimeView() {
    return {
      requests: this.requestManager.list(),
      store: this.store.list(),
      catalogState: id => this.catalog.getManifestState(id)
    };
  }
  async #ensureActive() {
    const current = this.playlist[this.currentVideoIndex].videoId;
    if (this.catalog.getManifestState(current) !== MANIFEST_STATE.AVAILABLE) return;
    if (this.pool.slot?.videoId === current && this.pool.slot.port) return;
    if (this.activeSlotPromise && this.activeSlotVideoId === current) return this.activeSlotPromise;
    this.activeSlotVideoId = current;
    const pending = this.bridge.activate(current);
    const wrapped = pending.finally(() => {
      if (this.activeSlotPromise === wrapped) {
        this.activeSlotPromise = null;
        this.activeSlotVideoId = null;
        if (this.playback.videoId === current) {
          this.lastPlaybackSegment = -1;
          this.stallStart = null;
        }
      }
    });
    this.activeSlotPromise = wrapped;
    return wrapped;
  }
  async #drain() {
    if (this.draining || this.stopped || this.ending) return;
    this.draining = true;
    try {
      await this.#ensureActive();
      this.abr.decideIfNeeded(this.#runtimeView());
    } catch (error) {
      if (error.code !== 'SFV_SLOT_REPLACED') {
        this.abr.pending.splice(0);
        this.#observe({
          eventType: 'SFV_RUNTIME_ERROR',
          error: error.message,
          triggerDecision: false
        });
        this.onError(error);
      }
    } finally {
      this.draining = false;
      if (this.abr.shouldTrigger(this.abr.pending) && !this.stopped) this.#schedule();
    }
  }
  #dispatch(actions) {
    for (const action of actions) {
      if (action.actionType === ACTION.APPEND) {
        this.bridge.appendCached(action).catch(error => this.onError(error));
      } else {
        try {
          this.requestManager.dispatch(action);
        } catch (error) {
          this.#observe({
            eventType: 'SFV_DISPATCH_FAILED',
            error: error.message,
            action,
            triggerDecision: false
          });
          this.onError(error);
        }
      }
    }
  }
  #bindPlaybackEvents() {
    const add = (name, handler) => {
      this.videoElement.addEventListener(name, handler);
      this.listeners.push([name, handler]);
    };
    add('playing', () => {
      if (!this.playback.ready) return;
      const videoId = this.playback.videoId;
      // A pre-start `waiting` event belongs to startup delay, not a rebuffer.
      if (!this.startedVideos.has(videoId)) {
        this.startedVideos.add(videoId);
        this.stallStart = null;
        this.#observe({
          eventType: 'PLAYBACK_STARTED',
          videoId,
          positionS: this.videoElement.currentTime
        });
      } else if (this.stallStart !== null) {
        this.playback.stalls.push({
          startS: this.stallStart,
          durationS: this.time() - this.stallStart
        });
        this.stallStart = null;
        this.#observe({ eventType: 'STALL_RECOVERED', videoId });
      }
      this.#sampleProgress();
      this.#recordRendered();
    });
    add('waiting', () => {
      this.#sampleProgress();
      if (
        this.startedVideos.has(this.playback.videoId) &&
        !this.videoElement.paused &&
        !this.videoElement.seeking &&
        this.stallStart === null
      ) {
        this.stallStart = this.time();
        this.#observe({ eventType: 'STALL_STARTED', videoId: this.playback.videoId });
      }
    });
    add('seeking', () => {
      this.#sampleProgress();
      this.seekPending = true;
      this.#endStall('seeking');
    });
    add('seeked', () => {
      this.#sampleProgress(true);
    });
    add('pause', () => {
      this.#sampleProgress();
      this.#endStall('paused');
    });
    add('ended', () => {
      this.#sampleProgress();
      this.#endStall('video_completed');
      this.#observe({ eventType: 'VIDEO_COMPLETED', videoId: this.playback.videoId });
    });
    add('error', () =>
      this.#observe({
        eventType: 'PLAYBACK_ERROR',
        videoId: this.playback.videoId,
        error: this.videoElement.error?.message ?? 'HTMLMediaElement error'
      })
    );
    add('timeupdate', () => {
      this.#sampleProgress();
      if (this.startedVideos.has(this.playback.videoId) && this.playback.ready) {
        this.#cleanupPassed(this.playback.videoId, this.videoElement.currentTime);
      }
      const snapshot = this.playback.snapshot();
      const v = this.catalog.dataset.videos.find(v => v.videoId === this.playback.videoId);
      const segments = v?.representations?.video?.[0]?.segments ?? [];
      const segment = segments.find(
        s => s.startS <= snapshot.positionS && snapshot.positionS < s.startS + s.durationS
      );
      if (!segment || segment.index === this.lastPlaybackSegment) return;
      this.lastPlaybackSegment = segment.index;
      this.#recordRendered();
      this.#observe({
        eventType: 'PLAYBACK_POSITION_UPDATED',
        videoId: this.playback.videoId,
        positionS: snapshot.positionS,
        triggerDecision: true
      });
    });
  }
  #sampleProgress(discontinuity = false) {
    const videoId = this.playback.videoId;
    if (!this.startedVideos.has(videoId) || !Number.isFinite(this.videoElement.currentTime)) return;
    const pos = this.videoElement.currentTime;
    const reset =
      discontinuity ||
      this.seekPending ||
      this.lastSampleVideoId !== videoId ||
      (this.lastSamplePosition !== null && pos < this.lastSamplePosition - 1e-7);
    if (
      reset ||
      this.lastSamplePosition === null ||
      Math.abs(pos - this.lastSamplePosition) > 1e-7
    ) {
      this.#cleanupPassed(videoId, pos);
      this.#observe({
        eventType: 'PLAYBACK_POSITION_SAMPLE',
        videoId,
        positionS: pos,
        discontinuity: !!reset,
        triggerDecision: false
      });
      this.lastSamplePosition = pos;
      this.lastSampleVideoId = videoId;
      this.seekPending = false;
    }
  }
  #cacheReleased(removed, cause) {
    for (const entry of removed)
      this.#observe({
        eventType: 'CACHE_RESOURCE_RELEASED',
        resource: entry.resource,
        bytes: entry.bytes,
        reason: cause,
        triggerDecision: false
      });
  }
  #cleanupPassed(videoId, positionS) {
    this.#cacheReleased(
      cleanupPassedSegments(this.store, {
        videoId,
        positionS,
        protectedKeys: [...this.bridge.appendPending]
      }),
      'PLAYBACK_CONSUMED'
    );
  }
  #endStall(reason) {
    if (this.stallStart === null) return;
    const now = this.time();
    this.playback.stalls.push({
      startS: this.stallStart,
      endS: now,
      durationS: now - this.stallStart
    });
    this.stallStart = null;
    this.#observe({
      eventType: 'STALL_ENDED',
      videoId: this.playback.videoId,
      reason,
      triggerDecision: false
    });
  }
  #recordRendered() {
    if (!this.playback.ready || this.videoElement.readyState < 2) return;
    const video = this.catalog.dataset.videos.find(v => v.videoId === this.playback.videoId);
    const positionS = this.videoElement.currentTime;
    const segments = video?.representations?.video?.[0]?.segments ?? [];
    const segment = segments.find(s => s.startS <= positionS && positionS < s.startS + s.durationS);
    if (!segment || this.playback.rendered.some(r => r.segmentIndex === segment.index)) return;
    const key = [...this.bridge.appended].find(
      k => k.startsWith(`${this.playback.videoId}|video|`) && k.endsWith(`|media|${segment.index}`)
    );
    if (!key) return;
    this.playback.rendered.push({
      segmentIndex: segment.index,
      representationId: key.split('|')[2],
      time: this.time(),
      playbackPositionS: positionS,
      measurement: 'HTMLMediaElement-timeupdate'
    });
  }
  start() {
    if (this.started) throw new Error('Session already started');
    // Session time zero is the user's app-open action, not controller construction.
    this.epochStart = this.now();
    this.started = true;
    this.#observe({
      eventType: 'SESSION_STARTED',
      scheduling: structuredClone(this.config.scheduling)
    });
    this.#observe({
      eventType: 'PLAY_REQUESTED',
      videoId: this.playback.videoId,
      cause: 'session_start',
      triggerDecision: false
    });
    return this;
  }
  #tryAutomaticPlayback(videoId) {
    if (
      videoId !== this.playback.videoId ||
      !this.playback.ready ||
      this.startedVideos.has(videoId) ||
      this.autoPlayAttempted.has(videoId)
    )
      return;
    this.autoPlayAttempted.add(videoId);
    let attempt;
    try {
      attempt = this.videoElement.play();
    } catch (error) {
      attempt = Promise.reject(error);
    }
    Promise.resolve(attempt).catch(error => {
      if (this.stopped || this.playback.videoId !== videoId) return;
      if (error.name === 'AbortError') {
        // A new SourceBuffer/slot may cancel a pending play request. A later
        // successfully appended segment may safely trigger one more attempt.
        this.autoPlayAttempted.delete(videoId);
      }
      this.#observe({
        eventType: 'PLAY_REQUEST_FAILED',
        videoId,
        cause: 'automatic',
        error: error.message,
        triggerDecision: false
      });
      if (error.name === 'NotAllowedError') this.onAutoplayBlocked(videoId);
      else if (error.name !== 'AbortError')
        this.onError(new Error(`Automatic playback failed: ${error.message}`));
    });
  }
  play({ cause = 'user' } = {}) {
    if (!this.started || this.stopped) throw new Error('Start an active session before playing');
    const videoId = this.playback.videoId;
    this.#observe({ eventType: 'PLAY_REQUESTED', videoId, cause, triggerDecision: false });
    // Call play synchronously from the click handler: browsers may require
    // transient user activation for media playback.
    let promise;
    try {
      promise = this.videoElement.play();
    } catch (error) {
      promise = Promise.reject(error);
    }
    return Promise.resolve(promise).catch(error => {
      this.#observe({
        eventType: 'PLAY_REQUEST_FAILED',
        videoId,
        error: error.message,
        triggerDecision: false
      });
      throw error;
    });
  }
  async swipeNext() {
    if (this.stopped || this.currentVideoIndex >= this.playlist.length - 1) return false;
    const from = this.playlist[this.currentVideoIndex].videoId;
    this.#sampleProgress();
    this.#endStall('swipe');
    this.playbacks[from] = this.playback.snapshot();
    const to = this.playlist[++this.currentVideoIndex].videoId;
    this.#observe({ eventType: 'SWIPE', fromVideoId: from, toVideoId: to, triggerDecision: true });
    this.#observe({
      eventType: 'PLAY_REQUESTED',
      videoId: to,
      cause: 'swipe',
      triggerDecision: false
    });
    if (this.config.scheduling.swipeCancellation)
      this.requestManager.cancelPlaybackRequestsForVideo(from);
    this.pool.reset();
    this.activeSlotPromise = null;
    this.activeSlotVideoId = null;
    this.#cacheReleased(cleanupDepartedVideo(this.store, { videoId: from }), 'VIDEO_DEPARTED');
    this.lastPlaybackSegment = -1;
    this.stallStart = null;
    this.lastSamplePosition = null;
    this.lastSampleVideoId = null;
    this.playback.activate(to);
    this.autoPlayAttempted.delete(to);
    this.bridge.appended.clear();
    this.bridge.appendPending.clear();
    this.bridge.initialized.clear();
    this.#schedule();
    return true;
  }
  recordExperimentEvent(event) {
    if (!this.started || this.stopped) throw new Error('Session is not active');
    const { eventType, ...details } = event;
    this.#observe({ eventType: 'USER_AUTOMATION_EVENT', ...details, triggerDecision: false });
  }
  result(terminationReason = 'simulation_cutoff', { samplePlayback = true } = {}) {
    // Diagnostic polling must not inject new observations into the ABR rule.
    if (samplePlayback) this.#sampleProgress();
    const playbacks = { ...this.playbacks, [this.playback.videoId]: this.playback.snapshot() };
    const requests = this.requestManager.list();
    return {
      timeS: this.time(),
      terminationReason,
      cache: this.store.stats(),
      events: this.observations.list(),
      requests,
      ruleState: this.abr.getState(),
      sessionRecord: SFVSessionRecordBuilder.build({
        config: this.config,
        dataset: this.catalog.dataset,
        requests,
        userEvents: this.userEvents,
        playbackEvents: this.playbackEvents,
        playbacks,
        allEvents: this.observations.list(),
        endTimeS: this.time(),
        terminationReason
      })
    };
  }
  stopAndDrain({ timeoutMs = 2000 } = {}) {
    if (this.stopPromise) return this.stopPromise;
    if (this.stopped) return Promise.resolve(this.result('session_end'));
    this.stopPromise = (async () => {
      this.ending = true;
      if (this.scheduleTimer !== null) {
        clearTimeout(this.scheduleTimer);
        this.scheduleTimer = null;
        this.scheduled = false;
      }
      this.requestManager.cancelAll('SESSION_END');
      const settled = await this.requestManager.waitForTerminal({ timeoutMs });
      const result = this.stop();
      result.requestTerminationSettled = settled;
      return result;
    })();
    return this.stopPromise;
  }
  stop() {
    if (this.stopped) return this.result('session_end');
    if (this.started) this.#observe({ eventType: 'SESSION_ENDED', triggerDecision: false });
    const result = this.result('session_end');
    this.stopped = true;
    if (this.scheduleTimer !== null) {
      clearTimeout(this.scheduleTimer);
      this.scheduleTimer = null;
      this.scheduled = false;
    }
    for (const [event, listener] of this.listeners)
      this.videoElement.removeEventListener(event, listener);
    this.requestManager.reset();
    this.bridge.reset();
    return result;
  }
}
