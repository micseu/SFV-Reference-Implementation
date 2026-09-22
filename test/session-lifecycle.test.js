import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { resolveSessionTiming } from '../src/simulation/SFVSessionTiming.js';
import { SFVBrowserController } from '../src/dashjs/SFVBrowserController.js';
import { calculatePlaybackLatency } from '../src/output/SFVPlaybackLatencyCalculator.js';
import { calculatePlaybackMetrics } from '../src/output/SFVPlaybackMetricsCalculator.js';

const dataset = JSON.parse(fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url)));
const config = {maxTimeS: 14, transport: {capacityMbps: 8, latencyMs: 30},
  rule: {activeBufferTargetSegments: 2}, swipeTimesS: [2.5]};
function simulation(extra = {}) {
  return new SFVSimulationController({dataset, rule:new SFVCurrentVideoRule(),
    config:{...config,...extra}}).run();
}

test('fixed session start has no earlier requests and measures startup from session start', () => {
  const out = simulation({sessionStartTimeS: 4, sessionDurationS: 6});
  const events = out.events;
  const started = events.find(e => e.eventType === 'SESSION_STARTED');
  const firstRequest = events.find(e => e.eventType === 'REQUEST_STARTED');
  assert.equal(started.time, 4);
  assert.ok(firstRequest.time >= 4);
  assert.ok(events.every(e => e.time >= 4));
  assert.equal(out.terminationReason, 'session_end');
  assert.equal(out.timeS, 10);
  assert.equal(out.sessionRecord.session_timing.scheduled_start_at_s, 4);
  assert.equal(out.sessionRecord.session_timing.scheduled_end_at_s, 10);
  assert.equal(out.sessionRecord.playback_latency.initial.session_started_at_s, 4);
  assert.equal(out.sessionRecord.playback_latency.initial.play_requested_at_s, 4);
  const firstPlayback = events.find(e => e.eventType === 'PLAYBACK_STARTED' && e.videoId === 'v1');
  assert.ok(firstPlayback);
  assert.ok(Math.abs(out.sessionRecord.session_summary.initial_playback_delay_s - (firstPlayback.time - 4)) < 1e-8);
  assert.ok(events.some(e => e.eventType === 'SWIPE' && Math.abs(e.time - 6.5) < 1e-8));
});

test('seeded start/duration draws are reproducible, independent across UEs and bounded', () => {
  const base = {sessionStartWindowS:[2,5],sessionDurationRangeS:[4,7],seed:42,ueId:0,sessionId:'ue-0'};
  const a = resolveSessionTiming(base);
  assert.deepEqual(a,resolveSessionTiming(base));
  assert.ok(a.startTimeS>=2 && a.startTimeS<=5);
  assert.ok(a.endTimeS-a.startTimeS>=4 && a.endTimeS-a.startTimeS<=7);
  assert.notEqual(a.startTimeS,resolveSessionTiming({...base,ueId:1,sessionId:'ue-1'}).startTimeS);
  assert.deepEqual(simulation({...base}),simulation({...base}));
});

test('late session beyond measurement cutoff stays inactive and has no fabricated delay', () => {
  const out = simulation({maxTimeS:3,sessionStartTimeS:4,sessionDurationS:4});
  assert.equal(out.terminationReason,'simulation_cutoff');
  assert.equal(out.requests.length,0);
  assert.ok(!out.events.some(e=>e.eventType==='SESSION_STARTED'));
  assert.equal(out.sessionRecord.playback_latency.initial.delay_s,null);
  assert.equal(out.sessionRecord.session_summary.initial_playback_delay_s,null);
});

test('multi-UE runner staggers default start and end times on experiment clock', () => {
  const runner = new SFVSimulationRunner({dataset,
    sessions:[0,1,2].map(i=>({ruleFactory:()=>new SFVCurrentVideoRule(),
      config:{...config,seed:17,sessionId:`ue-${i}`,ueId:i}}))});
  const out=runner.run();
  const starts=out.map(v=>v.sessionRecord.session_timing.session_started_at_s);
  const ends=out.map(v=>v.sessionRecord.session_timing.scheduled_end_at_s);
  assert.equal(new Set(starts).size,3);
  assert.equal(new Set(ends).size,3);
  assert.ok(out.every(v=>v.events.every(e=>e.time>=v.sessionRecord.session_timing.session_started_at_s)));
  assert.deepEqual(starts,runner.run().map(v=>v.sessionRecord.session_timing.session_started_at_s));
});

test('conflicting and invalid session timing fails fast', () => {
  assert.throws(()=>resolveSessionTiming({sessionStartTimeS:1,sessionStartWindowS:[0,2]}),/Choose/);
  assert.throws(()=>resolveSessionTiming({sessionEndTimeS:5,sessionDurationS:3}),/Choose/);
  assert.throws(()=>resolveSessionTiming({sessionStartTimeS:5,sessionEndTimeS:4}),/strictly after/);
  assert.throws(()=>resolveSessionTiming({sessionDurationRangeS:[0,3]}),/non-negative/);
});

test('latency uses SESSION_STARTED before play retry rather than resetting its timer', () => {
  const latency=calculatePlaybackLatency({dataset,
    allEvents:[{eventType:'SESSION_STARTED',time:3}],
    playbackEvents:[{eventType:'PLAY_REQUESTED',videoId:'v1',time:3},
      {eventType:'PLAY_REQUEST_FAILED',videoId:'v1',time:3.2},
      {eventType:'PLAY_REQUESTED',videoId:'v1',time:4.2},
      {eventType:'PLAYBACK_STARTED',videoId:'v1',time:5}],userEvents:[]});
  assert.equal(latency.initial.start_reference,'session_start');
  assert.equal(latency.initial.delay_s,2);
  assert.equal(latency.initial.play_requested_at_s,3);
});

function videoMock(){
  const listeners=new Map();let calls=0;
  return {currentTime:0,duration:6,readyState:3,paused:true,seeking:false,
    buffered:{length:0},get calls(){return calls;},
    addEventListener:(name,fn)=>listeners.set(name,[...(listeners.get(name)??[]),fn]),
    removeEventListener:(name,fn)=>listeners.set(name,(listeners.get(name)??[]).filter(f=>f!==fn)),
    play:()=>{calls++;return Promise.resolve();},
    fire:name=>(listeners.get(name)??[]).forEach(fn=>fn())};
}

test('browser session start records startup intent and auto-plays on first buffer append',async()=>{
  let time=100;
  const video=videoMock();
  const ctrl=new SFVBrowserController({dashjs:{MediaPlayer:()=>({})},parseDashManifest:()=>({}),
    videoElement:video,playlist:[{videoId:'v1',manifestUrl:'http://localhost/v1.mpd'}],
    rule:new SFVCurrentVideoRule(),now:()=>time,onError:()=>{}});
  try {
    time=105;
    ctrl.start();
    assert.equal(video.calls,0);
    assert.equal(ctrl.observations.events.find(e=>e.eventType==='SESSION_STARTED').time,0);
    time=106;
    ctrl.playback.ready=true;
    ctrl.pool.slot={videoId:'v1',port:{},player:{reset:()=>{}}};
    ctrl.bridge.appended.add('v1|video|0|media|0');
    ctrl.bridge.onEvent({eventType:'RESOURCE_APPENDED',videoId:'v1',segmentIndex:0,representationId:'0',triggerDecision:false});
    assert.equal(video.calls,1);
    time=106.2;
    video.fire('playing');
    const out=ctrl.result();
    assert.ok(Math.abs(out.sessionRecord.session_summary.initial_playback_delay_s-1.2)<1e-8);
    assert.equal(out.sessionRecord.playback_latency.initial.start_reference,'session_start');
  } finally {ctrl.stop();}
});

test('browser swipe requests playback automatically and keeps independent swipe delay', async () => {
  let time=0;
  const video=videoMock();
  const ctrl=new SFVBrowserController({dashjs:{MediaPlayer:()=>({})},parseDashManifest:()=>({}),
    videoElement:video,playlist:['v1','v2'].map(videoId=>({videoId,manifestUrl:`http://localhost/${videoId}.mpd`})),
    rule:new SFVCurrentVideoRule(),now:()=>time,onError:()=>{}});
  try {
    ctrl.start();
    ctrl.playback.ready=true;
    ctrl.pool.slot={videoId:'v1',port:{},player:{reset:()=>{}}};
    ctrl.bridge.onEvent({eventType:'RESOURCE_APPENDED',videoId:'v1',segmentIndex:0,representationId:'0',triggerDecision:false});
    time=0.4;
    video.fire('playing');
    time=2;
    assert.equal(await ctrl.swipeNext(),true);
    ctrl.playback.ready=true;
    ctrl.pool.slot={videoId:'v2',port:{},player:{reset:()=>{}}};
    time=2.3;
    ctrl.bridge.onEvent({eventType:'RESOURCE_APPENDED',videoId:'v2',segmentIndex:0,representationId:'0',triggerDecision:false});
    assert.equal(video.calls,2);
    time=2.5;
    video.fire('playing');
    const record=ctrl.result().sessionRecord;
    assert.ok(Math.abs(record.session_summary.initial_playback_delay_s-0.4)<1e-8);
    assert.ok(Math.abs(record.session_summary.swipe_wait_total_s-0.5)<1e-8);
    assert.equal(record.playback_latency.swipe_to_playback[0].status,'started');
  } finally {ctrl.stop();}
});

test('user session end closes a pending stall instead of labeling it open at export', () => {
  const events=[{eventType:'PLAYBACK_STARTED',videoId:'v1',time:1,positionS:0},
    {eventType:'STALL_STARTED',videoId:'v1',time:2}];
  const ended=calculatePlaybackMetrics({dataset,playbackEvents:events,endTimeS:4,terminationReason:'session_end'});
  const cutoff=calculatePlaybackMetrics({dataset,playbackEvents:events,endTimeS:4,terminationReason:'simulation_cutoff'});
  assert.equal(ended.stall_events[0].status,'session_end');
  assert.equal(ended.stall_events[0].ended_at_s,4);
  assert.equal(cutoff.stall_events[0].status,'open_at_export');
  assert.equal(cutoff.stall_events[0].ended_at_s,null);
});
