import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { calculatePlaybackLatency } from '../src/output/SFVPlaybackLatencyCalculator.js';
import { SFVSessionRecordBuilder } from '../src/output/SFVSessionRecordBuilder.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVBrowserController } from '../src/dashjs/SFVBrowserController.js';

const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);

function e(eventType, time, videoId, other = {}) {
  return { eventType, time, videoId, ...other };
}

test('startup delay starts at the first play click, not at manifest/slot activation', () => {
  const latency = calculatePlaybackLatency({
    dataset,
    playbackEvents: [
      e('VIDEO_ACTIVATED', 0, 'v1'),
      e('PLAY_REQUESTED', 4, 'v1'),
      e('PLAY_REQUESTED', 4.2, 'v1'),
      e('PLAYBACK_STARTED', 4.75, 'v1')
    ],
    userEvents: [],
    measurementSource: 'html_media_element_playing'
  });
  assert.equal(latency.initial.play_requested_at_s, 4);
  assert.equal(latency.initial.playback_started_at_s, 4.75);
  assert.equal(latency.initial.delay_s, 0.75);
  assert.equal(latency.initial.status, 'started');
  assert.equal(latency.measurement_source, 'html_media_element_playing');
});

test('each swipe has its own delay; an abandoned video has a null delay', () => {
  const latency = calculatePlaybackLatency({
    dataset,
    playbackEvents: [
      e('PLAY_REQUESTED', 0, 'v1'),
      e('PLAYBACK_STARTED', 1, 'v1'),
      e('PLAYBACK_STARTED', 4.1, 'v3')
    ],
    userEvents: [
      e('SWIPE', 2, 'v1', { fromVideoId: 'v1', toVideoId: 'v2' }),
      e('SWIPE', 4, 'v2', { fromVideoId: 'v2', toVideoId: 'v3' })
    ]
  });
  assert.equal(latency.swipe_to_playback.length, 2);
  assert.equal(latency.swipe_to_playback[0].delay_s, null);
  assert.equal(latency.swipe_to_playback[0].status, 'interrupted_by_next_swipe');
  assert.ok(Math.abs(latency.swipe_to_playback[1].delay_s - 0.1) < 1e-9);
  assert.equal(latency.swipe_to_playback[1].status, 'started');
});

test('unstarted startup and final swipe remain null, not zero', () => {
  const latency = calculatePlaybackLatency({
    dataset,
    playbackEvents: [e('PLAY_REQUESTED', 2, 'v1')],
    userEvents: [e('SWIPE', 3, 'v1', { fromVideoId: 'v1', toVideoId: 'v2' })]
  });
  assert.equal(latency.initial.delay_s, null);
  assert.equal(latency.initial.status, 'not_started');
  assert.equal(latency.swipe_to_playback[0].delay_s, null);
  assert.equal(latency.swipe_to_playback[0].status, 'not_started');
});

test('session builder retains legacy activation-to-start delay and adds user-facing metrics', () => {
  const record = SFVSessionRecordBuilder.build({
    config: {
      runId: 'r',
      sessionId: 's',
      seed: 1,
      latencyMeasurementSource: 'html_media_element_playing'
    },
    dataset,
    requests: [],
    playbacks: {},
    playbackEvents: [
      e('VIDEO_ACTIVATED', 0, 'v1'),
      e('PLAY_REQUESTED', 4, 'v1'),
      e('PLAYBACK_STARTED', 5, 'v1'),
      e('VIDEO_ACTIVATED', 8, 'v2'),
      e('PLAYBACK_STARTED', 8.3, 'v2')
    ],
    userEvents: [e('SWIPE', 8, 'v1', { fromVideoId: 'v1', toVideoId: 'v2' })]
  });
  assert.equal(record.videos[0].initial_loading_delay_s, 5);
  assert.equal(record.videos[0].play_request_to_playback_delay_s, 1);
  assert.ok(Math.abs(record.videos[1].swipe_to_playback_delay_s - 0.3) < 1e-9);
  assert.equal(record.session_summary.initial_playback_delay_s, 1);
  assert.ok(Math.abs(record.session_summary.swipe_to_playback_delays_s[0] - 0.3) < 1e-9);
  assert.equal(record.playback_latency.swipe_to_playback[0].from_video_id, 'v1');
});

test('simulator exposes existing activation delay plus new play/swipe intent timestamps', () => {
  const result = new SFVSimulationController({
    dataset,
    rule: new SFVCurrentVideoRule(),
    config: {
      maxTimeS: 5,
      swipeTimesS: [2.5],
      transport: { capacityMbps: 8, latencyMs: 20 },
      rule: { activeBufferTargetSegments: 2 }
    }
  }).run();
  const latency = result.sessionRecord.playback_latency;
  assert.equal(latency.measurement_source, 'simulated_playback_started');
  assert.equal(latency.initial.play_requested_at_s, 0);
  assert.equal(
    result.events.some(event => event.eventType === 'PLAY_REQUESTED'),
    true
  );
  assert.equal(latency.initial.delay_s, result.sessionRecord.videos[0].initial_loading_delay_s);
  assert.equal(latency.swipe_to_playback.length, 1);
  if (latency.swipe_to_playback[0].status === 'started') {
    assert.ok(
      Math.abs(
        latency.swipe_to_playback[0].delay_s -
          result.sessionRecord.videos[1].initial_loading_delay_s
      ) < 1e-8
    );
  }
});

function mockVideoElement() {
  const listeners = new Map();
  return {
    currentTime: 0,
    duration: 6,
    readyState: 3,
    buffered: { length: 0 },
    addEventListener: (name, fn) => {
      const group = listeners.get(name) ?? [];
      group.push(fn);
      listeners.set(name, group);
    },
    removeEventListener: (name, fn) =>
      listeners.set(
        name,
        (listeners.get(name) ?? []).filter(f => f !== fn)
      ),
    play: () => Promise.resolve(),
    fire: name => (listeners.get(name) ?? []).forEach(fn => fn())
  };
}

test('browser records actual play() intent, ignores pre-start waiting, and measures each swipe', async () => {
  let clock = 0;
  const video = mockVideoElement();
  const controller = new SFVBrowserController({
    dashjs: { MediaPlayer: () => ({}) },
    parseDashManifest: () => ({}),
    videoElement: video,
    playlist: ['v1', 'v2'].map(videoId => ({
      videoId,
      manifestUrl: `http://localhost/${videoId}.mpd`
    })),
    rule: new SFVCurrentVideoRule(),
    now: () => clock,
    onError: () => {}
  });
  try {
    controller.start();
    clock = 2;
    await controller.play();
    video.fire('waiting');
    clock = 2.4;
    controller.playback.ready = true;
    video.fire('playing');
    video.fire('playing');
    assert.equal(controller.playbacks.v1, undefined);
    clock = 3;
    assert.equal(await controller.swipeNext(), true);
    await controller.play({ cause: 'swipe' });
    controller.playback.ready = true;
    clock = 3.35;
    video.fire('playing');
    const out = controller.result();
    assert.ok(Math.abs(out.sessionRecord.playback_latency.initial.delay_s - 2.4) < 1e-9);
    assert.ok(
      Math.abs(out.sessionRecord.playback_latency.swipe_to_playback[0].delay_s - 0.35) < 1e-9
    );
    assert.equal(out.events.filter(ev => ev.eventType === 'PLAYBACK_STARTED').length, 2);
    assert.equal(out.sessionRecord.videos[0].stall_count, 0);
  } finally {
    controller.stop();
  }
});
