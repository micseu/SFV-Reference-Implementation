import test from 'node:test';
import assert from 'node:assert/strict';
import {SFVSimulatedPlaybackAgent} from '../src/simulation/SFVSimulatedPlaybackAgent.js';
import {extractBrowserPlaybackTiming} from '../src/simulation/SFVBrowserPlaybackTiming.js';
import {validateExperimentSpec} from '../src/experiment/SFVExperimentSpec.js';

const media={videoId:'v1',segmentIndex:0};

test('playback cannot begin before segment append, even if the browser timing suggests an earlier start',()=>{
  const agent=new SFVSimulatedPlaybackAgent();
  agent.activate('v1',6,2,0,{startupDelayS:0.08,recoveryDelayS:0.06});
  agent.advanceTo(1.5);
  assert.equal(agent.started,false);
  agent.append(media,'0',1.5);
  assert.equal(agent.started,false);
  assert.equal(agent.nextEventTime(1.5),1.58);
  agent.advanceTo(1.57);
  assert.equal(agent.started,false);
  agent.advanceTo(1.58);
  assert.equal(agent.started,true);
  assert.equal(agent.positionS,0);
  agent.advanceTo(2.58);
  assert.ok(Math.abs(agent.positionS-1)<1e-8);
});

test('a delayed stalled playback resumes causally only after appended bytes and recovery latency',()=>{
  const agent=new SFVSimulatedPlaybackAgent();
  agent.activate('v1',6,2,0,{recoveryDelayS:0.06});
  agent.append(media,'0',0);
  agent.advanceTo(2);
  assert.equal(agent.stalled,true);
  agent.advanceTo(5);
  agent.append({videoId:'v1',segmentIndex:1},'0',5);
  assert.equal(agent.stalled,true);
  agent.advanceTo(5.06);
  assert.equal(agent.stalled,false);
  assert.equal(agent.positionS,2);
  assert.equal(agent.stalls.length,1);
  assert.ok(Math.abs(agent.stalls[0].durationS-3.06)<1e-8);
});

test('browser playback timing extracts only platform-event offsets, not observed positions or ABR outcomes',()=>{
  const browser={events:[
    {eventType:'SESSION_STARTED',time:0},
    {eventType:'PLAYBACK_SLOT_READY',time:0.3,videoId:'v1'},
    {eventType:'RESOURCE_APPENDED',time:0.5,videoId:'v1',segmentIndex:0},
    {eventType:'PLAYBACK_STARTED',time:0.56,videoId:'v1'},
    {eventType:'PLAYBACK_POSITION_SAMPLE',time:0.84,positionS:0.28,videoId:'v1'},
    {eventType:'PLAYBACK_POSITION_SAMPLE',time:1.12,positionS:0.56,videoId:'v1'}
  ]};
  const timing=extractBrowserPlaybackTiming(browser,['v1']);
  assert.deepEqual(timing.videos.v1.sampleOffsetsS,[0.28,0.56]);
  assert.ok(Math.abs(timing.videos.v1.startupDelayS-0.06)<1e-8);
  assert.equal(timing.videos.v1.slotReadyAtS,0.3);
  assert.equal(JSON.stringify(timing).includes('positionS'),false);
  assert.equal(JSON.stringify(timing).includes('representationId'),false);
  const bad=structuredClone(browser);
  bad.events.splice(2,1);
  assert.throws(()=>extractBrowserPlaybackTiming(bad,['v1']),/Incomplete\/noncausal/);
});

test('experiment rejects nonmonotonic/malformed externally provided browser timing',()=>{
  const valid={schemaVersion:1,experimentId:'test',content:{playlist:['v1']},network:{capacityMbps:8},
    sessions:[{abr:{name:'current'},config:{playbackTiming:{mode:'browser-platform-trace',
      videos:{v1:{slotReadyAtS:0.3,startupDelayS:0.06,recoveryDelayS:0.04,sampleOffsetsS:[0.28,0.56]}}}}}]};
  assert.doesNotThrow(()=>validateExperimentSpec(valid));
  const bad=structuredClone(valid);
  bad.sessions[0].config.playbackTiming.videos.v1.sampleOffsetsS=[0.56,0.28];
  assert.throws(()=>validateExperimentSpec(bad),/sampleOffsetsS/);
});
