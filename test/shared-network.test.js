import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVSharedNetworkTransport } from '../src/simulation/SFVSharedNetworkTransport.js';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';

const dataset = JSON.parse(fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url)));
const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-7,
  `${actual} differs from ${expected}`);
const request = (id, size=1_000_000) => ({requestId:id,resource:{resourceType:'media'},bytesTotal:size});

test('shared constant rate: simultaneous UEs compete for one 8 Mbps bottleneck', () => {
  const net = new SFVSharedNetworkTransport({capacityMbps:8,latencyMs:0});
  const a = net.forUE(0); const b = net.forUE(1);
  a.start(request('a'),0); b.start(request('b'),0);
  net.advanceTo(0);
  close(net.nextEventTime(),2);
  net.advanceTo(1);
  close(a.get('a').bytesDelivered,500_000);
  close(b.get('b').bytesDelivered,500_000);
  assert.equal(a.get('b'),null);
  assert.equal(a.list().length,1);
  assert.equal(b.list().length,1);
  const events=net.advanceTo(2);
  assert.equal(events.filter(e=>e.eventType==='REQUEST_COMPLETED').length,2);
  close(a.get('a').finalBytesDelivered,1_000_000);
});

test('new UE joins mid-transfer and unfinished requests are reallocated immediately', () => {
  const net=new SFVSharedNetworkTransport({capacityMbps:8,latencyMs:0});
  net.forUE(0).start(request('a'),0);
  net.advanceTo(0.5);
  net.forUE(1).start(request('b'),0.5);
  net.advanceTo(0.5);
  close(net.nextEventTime(),1.5);
  net.advanceTo(1.5);
  assert.equal(net.get('a').state,'COMPLETED');
  close(net.get('b').bytesDelivered,500_000);
  close(net.nextEventTime(),2);
  net.advanceTo(2);
  assert.equal(net.get('b').state,'COMPLETED');
});

test('capacity trace is piecewise constant and pauses all transfers during zero capacity', () => {
  const net=new SFVSharedNetworkTransport({capacityTrace:[[0,8],[1,4],[2,0],[4,8]],latencyMs:0});
  net.forUE(0).start(request('a',2_000_000),0);
  net.advanceTo(0);
  close(net.nextEventTime(),1);
  net.advanceTo(1);
  close(net.get('a').bytesDelivered,1_000_000);
  close(net.nextEventTime(),2);
  net.advanceTo(2);
  close(net.get('a').bytesDelivered,1_500_000);
  close(net.nextEventTime(),4);
  net.advanceTo(4);
  close(net.get('a').bytesDelivered,1_500_000);
  close(net.nextEventTime(),4.5);
  net.advanceTo(4.5);
  assert.equal(net.get('a').state,'COMPLETED');
  close(net.get('a').endTime,4.5);
});

test('trace validation rejects ambiguous or invalid configurations',()=>{
  for (const trace of [[],[[1,3]],[[0,8],[0,4]],[[0,8],[-1,5]],[[0,-1]],[[0,NaN]],[[0,8,7]]]) {
    assert.throws(()=>new SFVSharedNetworkTransport({capacityTrace:trace}),/capacityTrace/);
  }
  assert.throws(()=>new SFVSharedNetworkTransport({capacityMbps:8,capacityTrace:[[0,8]]}),/both/);
  assert.throws(()=>new SFVSharedNetworkTransport({latencyMs:-1}),/latencyMs/);
});

test('abort affects only owned request, retains cancellation tail and releases shared rate',()=>{
  const net=new SFVSharedNetworkTransport({capacityMbps:8,latencyMs:0,cancelTailBytes:1_000,cancelTailMs:100});
  const a=net.forUE(0),b=net.forUE(1);
  a.start(request('a'),0);b.start(request('b'),0);
  net.advanceTo(0.2);
  assert.equal(a.abort('b',0.2),false);
  assert.equal(a.abort('a',0.2),true);
  close(net.nextEventTime(),0.3);
  net.advanceTo(0.3);
  assert.equal(a.get('a').state,'CANCELLED');
  close(a.get('a').finalBytesDelivered-a.get('a').bytesDeliveredAtAbort,1_000);
  close(b.get('b').bytesDelivered,200_000);
});

test('single UE in shared constant backend matches legacy request timing and startup',()=>{
  const config={maxTimeS:10,sessionStartTimeS:0,sessionDurationS:8,swipeTimesS:[],
    transport:{capacityMbps:8,latencyMs:50},rule:{activeBufferTargetSegments:2}};
  const legacy=new SFVSimulationController({dataset,rule:new SFVCurrentVideoRule(),config}).run();
  const runner=new SFVSimulationRunner({dataset,network:{capacityMbps:8,latencyMs:50},
    sessions:[{ruleFactory:()=>new SFVCurrentVideoRule(),config}]});
  const result=runner.run()[0];
  close(result.sessionRecord.session_summary.initial_playback_delay_s,
    legacy.sessionRecord.session_summary.initial_playback_delay_s);
  assert.deepEqual(result.requests.map(r=>[r.resource.resourceType,r.resource.segmentIndex,r.startTime,r.endTime]),
    legacy.requests.map(r=>[r.resource.resourceType,r.resource.segmentIndex,r.startTime,r.endTime]));
});

test('multi-UE session lifecycles, shared IDs, and seeded replay are deterministic',()=>{
  const options={dataset,network:{capacityTrace:[[0,8],[3,2],[6,8]],latencyMs:10},
    sessions:[0,1].map(index=>({ruleFactory:()=>index===0?new SFVCurrentVideoRule():new SFVMultiVideoPrefetchRule(),
      config:{sessionStartTimeS:index,sessionDurationS:5,maxTimeS:8,
        seed:3,sessionId:`ue-${index}`,ueId:index,swipeTimesS:[2],
        rule:{activeBufferTargetSegments:2,max_preload_segments:2,preload_segments_per_video:1}}}))};
  const a=new SFVSimulationRunner(options);
  const one=a.run();
  const b=new SFVSimulationRunner(options);
  assert.deepEqual(one,b.run());
  assert.deepEqual(a.lastNetworkReport,b.lastNetworkReport);
  assert.deepEqual(one.map(r=>r.sessionRecord.session_timing.session_started_at_s),[0,1]);
  assert.deepEqual(one.map(r=>r.sessionRecord.session_timing.session_ended_at_s),[5,6]);
  assert.ok(one[0].requests.every(r=>r.requestId.startsWith('ue0-')));
  assert.ok(one[1].requests.every(r=>r.requestId.startsWith('ue1-')));
  assert.ok(a.lastNetworkReport.requests.some(r=>r.ueIndex===0));
  assert.ok(a.lastNetworkReport.requests.some(r=>r.ueIndex===1));
  assert.ok(a.lastNetworkReport.events.some(e=>e.eventType==='NETWORK_CAPACITY_CHANGED'));
  assert.ok(one[0].events.every(e=>e.time>=0));
  assert.ok(one[1].events.every(e=>e.time>=1));
});

test('a UE starting after the cutoff never dispatches any network requests',()=>{
  const runner=new SFVSimulationRunner({dataset,network:{capacityMbps:8},sessions:[
    {ruleFactory:()=>new SFVCurrentVideoRule(),config:{maxTimeS:2,sessionStartTimeS:5,sessionDurationS:3}},
    {ruleFactory:()=>new SFVCurrentVideoRule(),config:{maxTimeS:2,sessionStartTimeS:0,sessionDurationS:1}}
  ]});
  const results=runner.run();
  assert.equal(results[0].requests.length,0);
  assert.equal(results[0].sessionRecord.session_summary.initial_playback_delay_s,null);
  assert.ok(results[1].requests.length>0);
});

test('capacity zero does not fabricate a first byte before available bandwidth', () => {
  const net=new SFVSharedNetworkTransport({capacityTrace:[[0,0],[3,8]],latencyMs:0});
  net.forUE(0).start(request('a',1_000_000),0);
  const initial=net.advanceTo(0);
  assert.ok(!initial.some(e=>e.eventType==='REQUEST_FIRST_BYTE'));
  close(net.nextEventTime(),3);
  const events=net.advanceTo(3);
  assert.ok(events.some(e=>e.eventType==='REQUEST_FIRST_BYTE'&&e.time===3));
  close(net.nextEventTime(),4);
  net.advanceTo(4);
  close(net.get('a').firstByteTime,3);
});

test('session end releases UE bandwidth with terminal cancellation; cutoff leaves unresolved bytes',()=>{
  const runner=new SFVSimulationRunner({dataset,network:{capacityMbps:1,latencyMs:0},
    sessions:[
      {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,sessionDurationS:0.03,
        maxTimeS:0.2,rule:{activeBufferTargetSegments:2}}},
      {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,sessionDurationS:0.2,
        maxTimeS:0.3,rule:{activeBufferTargetSegments:2}}}
    ]});
  const records=runner.run();
  assert.equal(records[0].terminationReason,'session_end');
  assert.ok(records[0].requests.some(r=>r.state==='CANCELLED'));
  assert.ok(runner.lastNetworkReport.requests.filter(r=>r.ueIndex===0)
    .every(r=>!['ACTIVE','CANCELLING'].includes(r.state)));
  assert.ok(records[1].requests.some(r=>r.startTime>=0));

  const cutoffRunner=new SFVSimulationRunner({dataset,network:{capacityMbps:1,latencyMs:0},
    sessions:[
      {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,maxTimeS:0.03,sessionEndTimeS:10}},
      {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,maxTimeS:0.1,sessionEndTimeS:10}}
    ]});
  const cutoff=cutoffRunner.run()[0];
  assert.equal(cutoff.terminationReason,'simulation_cutoff');
  assert.ok(cutoff.requests.some(r=>r.state==='ACTIVE'));
  assert.ok(cutoffRunner.lastNetworkReport.requests.filter(r=>r.ueIndex===0)
    .every(r=>!['ACTIVE','CANCELLING'].includes(r.state)));
});

test('full multi-UE integration exhibits contention (not independent per-UE capacity)',()=>{
  const makeSession=()=>({ruleFactory:()=>new SFVCurrentVideoRule(),
    config:{sessionStartTimeS:0,sessionDurationS:2,maxTimeS:3,
      swipeTimesS:[],rule:{activeBufferTargetSegments:2}}});
  const solo=new SFVSimulationRunner({dataset,network:{capacityMbps:1,latencyMs:0},
    sessions:[makeSession()]}).run()[0];
  const pair=new SFVSimulationRunner({dataset,network:{capacityMbps:1,latencyMs:0},
    sessions:[makeSession(),makeSession()]}).run();
  const soloDelay=solo.sessionRecord.session_summary.initial_playback_delay_s;
  const sharedDelays=pair.map(r=>r.sessionRecord.session_summary.initial_playback_delay_s);
  assert.ok(sharedDelays.every(delay=>delay>soloDelay));
  close(sharedDelays[0],sharedDelays[1]);
});
