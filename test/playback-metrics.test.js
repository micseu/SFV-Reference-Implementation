import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {calculatePlaybackMetrics} from '../src/output/SFVPlaybackMetricsCalculator.js';
import {SFVSessionRecordBuilder} from '../src/output/SFVSessionRecordBuilder.js';
import {SFVSimulationController} from '../src/simulation/SFVSimulationController.js';
import {SFVCurrentVideoRule} from '../src/rules/SFVCurrentVideoRule.js';
import {SFVBrowserController} from '../src/dashjs/SFVBrowserController.js';

const dataset=JSON.parse(fs.readFileSync(new URL('../fixtures/content/content.json',import.meta.url)));
const started=(videoId,time,positionS=0)=>({eventType:'PLAYBACK_STARTED',videoId,time,positionS});
const sample=(videoId,time,positionS,extra={})=>({eventType:'PLAYBACK_POSITION_SAMPLE',videoId,time,positionS,...extra});
const appended=(videoId,segmentIndex,representationId,time)=>({eventType:'RESOURCE_APPENDED',videoId,segmentIndex,representationId,time});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} !== ${b}`);

test('played media time is split by actual segment representation, not by downloads or wall-time stalls',()=>{
  const events=[appended('v1',0,'0',0),appended('v1',1,'2',0.2),appended('v2',0,'2',4.1)];
  const playback=[started('v1',1),sample('v1',3,2),
    {eventType:'STALL_STARTED',videoId:'v1',time:3},
    {eventType:'STALL_RECOVERED',videoId:'v1',time:4},
    sample('v1',4.5,2.5),started('v2',5.5),sample('v2',6.5,1)];
  const users=[{eventType:'SWIPE',fromVideoId:'v1',toVideoId:'v2',time:5}];
  const m=calculatePlaybackMetrics({dataset,playbackEvents:playback,userEvents:users,allEvents:events,endTimeS:7});
  close(m.per_video.v1.representation_played_duration_s['0'],2);
  close(m.per_video.v1.representation_played_duration_s['2'],0.5);
  close(m.per_video.v2.representation_played_duration_s['2'],1);
  assert.equal(m.quality_switch_count_within_video,1);
  assert.equal(m.quality_switch_count_between_videos,0); // v1 ends and v2 begins at 650 kbps
  assert.equal(m.quality_transitions.filter(t=>t.scope==='between_videos').length,1);
  close(m.quality_switches[0].at_s,3);
  assert.equal(m.stall_count_total,1);
  close(m.stall_duration_total_s,1);
  assert.deepEqual(m.per_video.v1.stall_events[0],{
    video_id:'v1',started_at_s:3,ended_at_s:4,observed_until_s:4,duration_s:1,status:'recovered'});
});

test('cross-video bitrate changes count even if representation IDs are identical',()=>{
  const altered=structuredClone(dataset);
  altered.videos[1].representations.video[0].bitrateKbps=999;
  const m=calculatePlaybackMetrics({dataset:altered,
    allEvents:[appended('v1',0,'0',0),appended('v2',0,'0',2)],
    playbackEvents:[started('v1',0),sample('v1',1,1),started('v2',2),sample('v2',3,1)],endTimeS:3});
  assert.equal(m.quality_switch_count_between_videos,1);
  assert.equal(m.quality_switch_count_within_video,0);
  assert.equal(m.quality_switches[0].from_representation_id,'0');
  assert.equal(m.quality_switches[0].to_representation_id,'0');
});

test('uncompleted stall is open and its duration is measured only through export',()=>{
  const events=[started('v1',0),sample('v1',1,1),{eventType:'STALL_STARTED',videoId:'v1',time:2}];
  const m=calculatePlaybackMetrics({dataset,playbackEvents:events,endTimeS:4});
  assert.equal(m.stall_count_total,1);
  close(m.stall_duration_total_s,2);
  assert.equal(m.stall_events[0].ended_at_s,null);
  assert.equal(m.stall_events[0].status,'open_at_export');
  assert.equal(m.stall_events[0].observed_until_s,4);
});

test('swipe ends an existing stall even without a recovery event',()=>{
  const m=calculatePlaybackMetrics({dataset,
    playbackEvents:[started('v1',0),{eventType:'STALL_STARTED',videoId:'v1',time:1}],
    userEvents:[{eventType:'SWIPE',fromVideoId:'v1',toVideoId:'v2',time:2.5}],endTimeS:4});
  assert.equal(m.stall_events[0].status,'swipe');
  close(m.stall_duration_total_s,1.5);
});

test('session summary adds swipe total and per-video representation duration without dropping null latencies',()=>{
  const record=SFVSessionRecordBuilder.build({dataset,requests:[],playbacks:{},endTimeS:5,
    config:{latencyMeasurementSource:'simulated_playback_started'},
    allEvents:[appended('v1',0,'0',0)],
    playbackEvents:[{eventType:'PLAY_REQUESTED',videoId:'v1',time:0},started('v1',1),sample('v1',2,1)],
    userEvents:[{eventType:'SWIPE',time:3,fromVideoId:'v1',toVideoId:'v2'}]});
  assert.equal(record.session_summary.initial_playback_delay_s,1);
  assert.equal(record.session_summary.swipe_wait_total_s,0);
  assert.equal(record.session_summary.swipe_wait_incomplete_count,1);
  assert.equal(record.session_summary.swipe_to_playback_delays_s[0],null);
  assert.equal(record.session_summary.representation_played_duration_s['v1|0'],1);
});

test('simulation emits media-position samples and attributes only played duration at cutoff',()=>{
  const out=new SFVSimulationController({dataset,rule:new SFVCurrentVideoRule(),config:{maxTimeS:5,
    swipeTimesS:[2.5],transport:{capacityMbps:8,latencyMs:20},rule:{activeBufferTargetSegments:2}}}).run();
  const record=out.sessionRecord;
  assert.ok(out.events.some(e=>e.eventType==='PLAYBACK_POSITION_SAMPLE'));
  for(const video of record.videos){
    const attributed=Object.values(video.representation_played_duration_s).reduce((a,b)=>a+b,0);
    assert.ok(attributed <= video.watch_duration_s + 1e-6);
    assert.ok(attributed >= 0);
  }
  assert.equal(record.session_summary.stall_count_total,record.playback_metrics.stall_count_total);
});

function videoMock(){
  const listeners=new Map();
  return {currentTime:0,readyState:3,duration:6,paused:false,seeking:false,
    buffered:{length:0},addEventListener:(key,fn)=>listeners.set(key,[...(listeners.get(key)??[]),fn]),
    removeEventListener:(key,fn)=>listeners.set(key,(listeners.get(key)??[]).filter(f=>f!==fn)),
    play:()=>Promise.resolve(),fire:key=>(listeners.get(key)??[]).forEach(fn=>fn())};
}

test('browser playhead samples and waiting/playing pair produce the same metric schema as DES',async()=>{
  let clock=0;
  const video=videoMock();
  const ctrl=new SFVBrowserController({dashjs:{MediaPlayer:()=>({})},parseDashManifest:()=>({}),
    videoElement:video,playlist:[{videoId:'v1',manifestUrl:'http://localhost/v1.mpd'}],
    rule:new SFVCurrentVideoRule(),now:()=>clock,onError:()=>{}});
  try{
    ctrl.start();clock=1;await ctrl.play();ctrl.playback.ready=true;clock=1.5;video.fire('playing');
    ctrl.catalog.dataset.videos[0]=structuredClone(dataset.videos[0]);
    ctrl.bridge.appended.add('v1|video|0|media|0');
    ctrl.abr.observe(appended('v1',0,'0',0.9));
    video.currentTime=1;clock=2.5;video.fire('timeupdate');
    clock=3;video.fire('waiting');
    clock=4;video.fire('playing');
    video.currentTime=1.5;clock=4.5;video.fire('timeupdate');
    const record=ctrl.result().sessionRecord;
    close(record.session_summary.initial_playback_delay_s,1.5);
    close(record.videos[0].representation_played_duration_s['0'],1.5);
    close(record.videos[0].stall_duration_s,1);
    assert.equal(record.videos[0].stall_count,1);
    assert.equal(record.videos[0].stall_events[0].started_at_s,3);
    assert.equal(record.videos[0].stall_events[0].ended_at_s,4);
  } finally {ctrl.stop();}
});

test('prefetched and appended but never played segments contribute zero played duration',()=>{
  const m=calculatePlaybackMetrics({dataset,
    allEvents:[appended('v1',0,'0',0),appended('v2',0,'2',0),appended('v2',1,'2',0)],
    playbackEvents:[started('v1',0.5),sample('v1',1.5,1)],endTimeS:2});
  assert.equal(Object.keys(m.per_video.v2.representation_played_duration_s).length,0);
  assert.equal(m.per_video.v2.representation_intervals.length,0);
  close(m.per_video.v1.representation_played_duration_s['0'],1);
});
