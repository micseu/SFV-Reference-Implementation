import { SCHEMA_VERSION } from '../core/constants.js';
import { calculateDataWastage } from './SFVDataWastageCalculator.js';
import { calculatePlaybackLatency } from './SFVPlaybackLatencyCalculator.js';
import { calculatePlaybackMetrics } from './SFVPlaybackMetricsCalculator.js';

function deliveredBytes(request) {
  return request.finalBytesDelivered ?? request.bytesDelivered ?? 0;
}

function roundReasons(reasons) {
  return Object.fromEntries(
    Object.entries(reasons).map(([reason, bytes]) => [reason, Math.round(bytes)])
  );
}

export class SFVSessionRecordBuilder {
  static build({
    config,
    sessionTiming = null,
    dataset,
    requests,
    userEvents,
    playbackEvents,
    playbacks,
    allEvents = [],
    endTimeS = null,
    terminationReason = 'simulation_cutoff'
  }) {
    const activationTimes = new Map(
      playbackEvents
        .filter((event) => event.eventType === 'VIDEO_ACTIVATED')
        .map((event) => [event.videoId, event.time])
    );

    const dataWastage = calculateDataWastage({
      dataset,
      requests,
      userEvents,
      playbacks,
      terminationReason
    });

    const cacheRejections=allEvents.filter(e=>e.eventType==='CACHE_ADMISSION_REJECTED');
    const cacheReleases=allEvents.filter(e=>e.eventType==='CACHE_RESOURCE_RELEASED');
    const playbackLatency = calculatePlaybackLatency({
      dataset,
      userEvents,
      playbackEvents,
      measurementSource: config.latencyMeasurementSource ?? 'unknown',
      allEvents
    });

    const playbackMetrics = calculatePlaybackMetrics({dataset,playbackEvents,userEvents,allEvents,endTimeS,terminationReason});

    const videos = dataset.videos.map((video, index) => {
      const videoRequests = requests.filter(
        (request) => request.resource?.videoId === video.videoId
      );
      const mediaRequests = videoRequests.filter(
        (request) => request.resource?.resourceType === 'media'
      );
      const bytesDelivered = videoRequests.reduce(
        (sum, request) => sum + deliveredBytes(request),
        0
      );
      const mediaBytesDelivered = mediaRequests.reduce(
        (sum, request) => sum + deliveredBytes(request),
        0
      );
      const swipe = userEvents.find(
        (event) => event.eventType === 'SWIPE' && event.fromVideoId === video.videoId
      );
      const playback = playbacks[video.videoId] ?? {
        stalls: [],
        positionS: 0,
        rendered: []
      };
      const videoDataWastage = dataWastage.byVideo.get(video.videoId);

      const activationTime = activationTimes.get(video.videoId);
      const firstRequest = videoRequests
        .filter((request) => Number.isFinite(request.firstByteTime))
        .sort((a, b) => a.startTime - b.startTime)[0];
      const playbackStarted = playbackEvents.find(
        (event) => event.eventType === 'PLAYBACK_STARTED' && event.videoId === video.videoId
      );

      return {
        video_id: video.videoId,
        video_sequence_number: index,
        video_duration_s: video.durationS ?? null,
        watch_duration_s: playback.positionS ?? 0,
        swiped_away: !!swipe,
        time_to_first_byte_s: firstRequest
          ? firstRequest.firstByteTime - firstRequest.startTime
          : null,
        initial_loading_delay_s:
          playbackStarted && Number.isFinite(activationTime)
            ? playbackStarted.time - activationTime
            : null,
        // These user-action delays are distinct from activation-to-startup delay.
        play_request_to_playback_delay_s: index === 0
          ? playbackLatency.initial.delay_s : null,
        swipe_to_playback_delay_s: playbackLatency.swipe_to_playback.find(
          (transition) => transition.to_video_id === video.videoId
        )?.delay_s ?? null,
        stall_count: playbackMetrics.per_video[video.videoId].stall_count,
        stall_duration_s: playbackMetrics.per_video[video.videoId].stall_duration_s,
        stall_events: playbackMetrics.per_video[video.videoId].stall_events,
        quality_switch_count: playbackMetrics.per_video[video.videoId].quality_switch_count,
        representation_intervals: playbackMetrics.per_video[video.videoId].representation_intervals,
        representation_played_duration_s: playbackMetrics.per_video[video.videoId].representation_played_duration_s,
        unattributed_played_duration_s: playbackMetrics.per_video[video.videoId].unattributed_played_duration_s,
        bytes_delivered: Math.round(bytesDelivered),
        bytes_media_delivered: Math.round(mediaBytesDelivered),
        bytes_data_wastage: Math.round(videoDataWastage.total),
        data_wastage_by_reason: roundReasons(videoDataWastage.reasons),
        bytes_unresolved_at_cutoff: Math.round(videoDataWastage.unresolvedAtCutoff),
        rendered_quality_timeline: playback.rendered ?? []
      };
    });

    const bytesDelivered = videos.reduce((sum, video) => sum + video.bytes_delivered, 0);
    const mediaBytesDelivered = videos.reduce(
      (sum, video) => sum + video.bytes_media_delivered,
      0
    );
    const roundedDataWastage = Math.round(dataWastage.total.total);

    return {
      schema_version: SCHEMA_VERSION,
      created_at: null,
      run_id: config.runId,
      session_id: config.sessionId,
      ue_id: config.ueId ?? null,
      condition: config.condition ?? 'synthetic',
      network_backend: config.networkBackend ?? 'constant_rate',
      signaling_level: 'L0',
      player_behavior: config.playerBehavior,
      swipe_profile: config.swipeProfile ?? config.userModel?.type ?? 'scripted',
      user_model: config.userModel ? structuredClone(config.userModel) : null,
      resolved_swipe_times_s: config.resolvedSwipeTimesS ?? null,
      seed: config.seed,
      transport_settings: config.transport,
      transport_generator: config.transportGenerator ?? null,
      cache_settings: config.cache ? structuredClone(config.cache) : null,
      retry_settings: config.requestRetry ? structuredClone(config.requestRetry) : null,
      termination_reason: terminationReason,
      session_timing: {
        session_started_at_s: playbackLatency.initial.session_started_at_s,
        scheduled_start_at_s: sessionTiming?.startTimeS ?? null,
        scheduled_end_at_s: Number.isFinite(sessionTiming?.endTimeS) ? sessionTiming.endTimeS : null,
        end_mode: sessionTiming?.endMode ?? 'browser_user_ended_or_measurement_cutoff',
        observed_until_s: endTimeS,
        session_ended_at_s: terminationReason === 'session_end' ? endTimeS : null
      },
      cache_lifecycle: {rejections:cacheRejections,releases:cacheReleases,
        rejected_bytes:cacheRejections.reduce((sum,e)=>sum+(e.cache?.bytes??0),0)},
      playback_latency: playbackLatency,
      playback_metrics: playbackMetrics,
      videos,
      session_summary: {
        initial_playback_delay_s: playbackLatency.initial.delay_s,
        swipe_to_playback_delays_s: playbackLatency.swipe_to_playback.map(
          (transition) => transition.delay_s
        ),
        swipe_wait_total_s: playbackLatency.swipe_to_playback.reduce((total, t) => total + (t.delay_s ?? 0), 0),
        swipe_wait_incomplete_count: playbackLatency.swipe_to_playback.filter(t => t.delay_s === null).length,
        quality_switch_count_total: playbackMetrics.quality_switch_count_total,
        quality_switch_count_within_video: playbackMetrics.quality_switch_count_within_video,
        quality_switch_count_between_videos: playbackMetrics.quality_switch_count_between_videos,
        representation_played_duration_s: playbackMetrics.representation_played_duration_s,
        videos_started: videos.filter((video) => video.watch_duration_s > 0).length,
        videos_completed: videos.filter(
          (video) => video.watch_duration_s >= video.video_duration_s - 1e-6
        ).length,
        stall_count_total: videos.reduce((sum, video) => sum + video.stall_count, 0),
        stall_duration_total_s: videos.reduce(
          (sum, video) => sum + video.stall_duration_s,
          0
        ),
        bytes_delivered: bytesDelivered,
        bytes_media_delivered: mediaBytesDelivered,
        bytes_data_wastage: roundedDataWastage,
        data_wastage_by_reason: roundReasons(dataWastage.total.reasons),
        data_wastage_ratio:
          mediaBytesDelivered > 0 ? roundedDataWastage / mediaBytesDelivered : null,
        bytes_unresolved_at_cutoff: Math.round(dataWastage.total.unresolvedAtCutoff)
      }
    };
  }
}
