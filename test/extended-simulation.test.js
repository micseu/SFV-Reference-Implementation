import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVSharedNetworkTransport } from '../src/simulation/SFVSharedNetworkTransport.js';
import { SFVSimulationRunner } from '../src/simulation/SFVSimulationRunner.js';
import { SFVSimulationController } from '../src/simulation/SFVSimulationController.js';
import { SFVCurrentVideoRule } from '../src/rules/SFVCurrentVideoRule.js';
import { SFVMultiVideoPrefetchRule } from '../src/rules/SFVMultiVideoPrefetchRule.js';
import {SFVSeededGenerator,SFVSequenceGenerator,resolveCapacityGenerator,
  resolveUserInteractions} from '../src/simulation/generators/SFVGenerators.js';
const dataset=JSON.parse(fs.readFileSync(new URL('../fixtures/content/content.json',import.meta.url)));
const req = id => ({requestId:id,bytesTotal:1_000_000,
  resource:{videoId:'v1',resourceType:'media',representationId:'0',segmentIndex:Number(id.replace(/\D/g,'')) || 0}});
const close=(a,b)=>assert.ok(Math.abs(a-b)<1e-7,`${a} != ${b}`);

test('shared network never enforces a request-count cap',()=>{
  const net=new SFVSharedNetworkTransport({capacityMbps:8,latencyMs:0});
  const a=net.forUE(0), b=net.forUE(1);
  assert.equal(a.start(req('a'),0).state,'ACTIVE');
  assert.equal(a.start(req('a2'),0).state,'ACTIVE');
  assert.equal(b.start(req('b'),0).state,'ACTIVE');
  net.advanceTo(1);
  close(a.get('a').bytesDelivered,1_000_000/3);
  close(a.get('a2').bytesDelivered,1_000_000/3);
  close(b.get('b').bytesDelivered,1_000_000/3);
});

test('per-UE request queue limits one client without limiting another client',()=>{
  const runner=new SFVSimulationRunner({dataset,network:{capacityMbps:8,latencyMs:0},sessions:[
    {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,sessionDurationS:4,maxTimeS:5,
      scheduling:{maxConcurrentRequests:1},swipeTimesS:[],rule:{activeBufferTargetSegments:2}}},
    {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,sessionDurationS:4,maxTimeS:5,
      scheduling:{maxConcurrentRequests:3},swipeTimesS:[],rule:{activeBufferTargetSegments:2}}}
  ]});
  const results=runner.run();
  assert.ok(results[0].events.some(e=>e.eventType==='REQUEST_QUEUED'));
  assert.ok(results[0].requests.some(r=>Number.isFinite(r.queuedAt)&&r.queueWaitS>0));
  assert.equal(runner.lastNetworkReport.concurrency.scope,'per_ue');
  assert.equal(runner.lastNetworkReport.concurrency.sessions[0].maxConcurrentRequests,1);
  assert.equal(runner.lastNetworkReport.concurrency.sessions[1].maxConcurrentRequests,3);
});

test('queued cancellation is local and never reaches the shared network',()=>{
  const runner=new SFVSimulationRunner({dataset,network:{capacityMbps:2,latencyMs:0},sessions:[
    {ruleFactory:()=>new SFVCurrentVideoRule(),config:{sessionStartTimeS:0,sessionDurationS:2,maxTimeS:3,
      scheduling:{maxConcurrentRequests:1,swipeCancellation:true},swipeTimesS:[0.3],rule:{activeBufferTargetSegments:3}}}
  ]});
  const [result]=runner.run();
  const queuedCancelled=result.requests.filter(r=>r.queuedAt!==undefined&&r.state==='CANCELLED'&&r.startTime===null);
  assert.ok(queuedCancelled.length>0);
  for(const request of queuedCancelled){
    assert.ok(!runner.lastNetworkReport.requests.some(r=>r.requestId===request.requestId));
  }
});

test('queue remains reserved for future media in B2 and never exceeds MPS',()=>{
  const runner=new SFVSimulationRunner({dataset,network:{capacityMbps:5,latencyMs:0},sessions:[{ruleFactory:()=>new SFVMultiVideoPrefetchRule(),
    config:{sessionStartTimeS:0,sessionDurationS:6,maxTimeS:8,swipeTimesS:[],scheduling:{maxConcurrentRequests:1},
      rule:{activeBufferTargetSegments:2,max_preload_segments:2,preload_segments_per_video:1}}}]});
  const result=runner.run()[0];
  const future=result.requests.filter(r=>r.resource.videoId!=='v1'&&r.resource.resourceType==='media');
  assert.equal(future.length,2,`future downloads: ${future.length}`);
  assert.ok(future.some(r=>Number.isFinite(r.queuedAt)&&r.queueWaitS>0), 'future media should wait in the UE queue');
  assert.ok(result.events.some(e=>e.eventType==='REQUEST_QUEUED'));
});

test('seeded generators replay and state restore match; sequences exhaust explicitly',()=>{
  const rng=new SFVSeededGenerator(23);
  const head=[rng.next(),rng.next()];const state=rng.getState();
  const next=rng.next();rng.setState(state);close(rng.next(),next);
  assert.deepEqual(head,[new SFVSeededGenerator(23).next(),(()=>{const x=new SFVSeededGenerator(23);x.next();return x.next();})()]);
  const list=new SFVSequenceGenerator([[0,8],[2,4]]);
  assert.deepEqual(list.next(),[0,8]);const saved=list.getState();
  assert.deepEqual(list.next(),[2,4]);assert.equal(list.next(),null);
  list.setState(saved);assert.deepEqual(list.next(),[2,4]);
});

test('capacity sequence and seeded traces validate and replay',()=>{
  assert.deepEqual(resolveCapacityGenerator({type:'sequence',trace:[[0,8],[3,0]]}).trace,[[0,8],[3,0]]);
  const model={type:'seeded',seed:23,capacityChoicesMbps:[0,4,8],
    holdDurationRangeS:[1,2],changes:4};
  const a=resolveCapacityGenerator(model),b=resolveCapacityGenerator(model);
  assert.deepEqual(a,b);
  assert.equal(a.trace.length,5);
  assert.ok(a.trace.slice(1).every((row,i)=>row[0]>a.trace[i][0]));
  assert.throws(()=>resolveCapacityGenerator({...model,holdDurationRangeS:[0,2]}),/holdDurationRangeS/);
});

test('sequence and seeded user actions remain session-relative, bounded and replayable',()=>{
  assert.deepEqual(resolveUserInteractions({type:'sequence',swipeTimesS:[1,3,5]},
    {maxSwipes:2,horizonS:4}),[1,3]);
  const args={maxSwipes:3,horizonS:10,seed:11};
  const model={type:'seeded',watchDurationRangeS:[1,2]};
  assert.deepEqual(resolveUserInteractions(model,args),resolveUserInteractions(model,args));
  assert.throws(()=>resolveUserInteractions({type:'sequence',swipeTimesS:[3,2]},args),/increasing/);
  const ctrl=new SFVSimulationController({dataset,rule:new SFVCurrentVideoRule(),config:{
    sessionStartTimeS:2,sessionDurationS:6,maxTimeS:10,
    userModel:{type:'sequence',swipeTimesS:[1,3]},seed:12}});
  assert.deepEqual(ctrl.swipeSchedule,[3,5]);
});

test('global runner resolves seeded network trace and per-UE user traces',()=>{
  const opts={dataset,network:{capacityGenerator:{type:'seeded',seed:19,
      capacityChoicesMbps:[4,8],holdDurationRangeS:[1,2],changes:2},latencyMs:0},sessions:[0,1].map(i=>({ruleFactory:()=>new SFVCurrentVideoRule(),
      config:{maxTimeS:8,sessionStartTimeS:i,sessionDurationS:5,seed:30+i,
        userModel:{type:'sequence',swipeTimesS:[2]},rule:{activeBufferTargetSegments:1}}}))};
  const a=new SFVSimulationRunner(opts),b=new SFVSimulationRunner(opts);
  assert.deepEqual(a.run(),b.run());
  assert.deepEqual(a.lastNetworkReport,b.lastNetworkReport);
  assert.equal(a.lastNetworkReport.capacityTrace.length,3);
});

test('browser request manager honors configured cap and aborts a queued request without starting HTTP',async()=>{
  const {SFVBrowserRequestManager}=await import('../src/dashjs/SFVBrowserRequestManager.js');
  const started=[],events=[],pending=new Map();
  const catalog={getResourceDescriptor:a=>({...a,url:`http://localhost/${a.videoId}.mpd`}),
    markManifestLoading:()=>{},markManifestFailed:()=>{},
    resolver:{parse:()=>({})},registerParsedManifest:()=>{}};
  const transport={onEvent:()=>{},start({requestId}){
    started.push(requestId);
    this.onEvent({eventType:'REQUEST_STARTED',requestId});
    return new Promise((resolve,reject)=>pending.set(requestId,{resolve,reject}));
  },abort:()=>{},reset:()=>{}};
  const manager=new SFVBrowserRequestManager({catalog,store:{has:()=>false},transport,
    now:()=>0,maxConcurrentRequests:1,onEvent:e=>events.push(e)});
  const one=manager.dispatch({actionType:'FETCH_MANIFEST',videoId:'v1'});
  const two=manager.dispatch({actionType:'FETCH_MANIFEST',videoId:'v2'});
  const three=manager.dispatch({actionType:'FETCH_MANIFEST',videoId:'v3'});
  assert.deepEqual(started,[one]);
  assert.equal(manager.get(two).state,'QUEUED');
  assert.equal(manager.abort(two,'SWIPE'),true);
  assert.equal(manager.get(two).state,'CANCELLED');
  pending.get(one).resolve(new Uint8Array(5));
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(started,[one,three]);
  assert.ok(events.some(e=>e.eventType==='REQUEST_QUEUED'&&e.requestId===two));
  assert.ok(events.some(e=>e.eventType==='REQUEST_CANCELLED'&&e.requestId===two));
  pending.get(three).resolve(new Uint8Array(5));
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(manager.get(three).state,'COMPLETED');
});

test('single-UE controller supports a generated trace and an active-request cap',()=>{
  const config={maxTimeS:4,sessionStartTimeS:0,sessionDurationS:3,transport:{
    capacityGenerator:{type:'sequence',trace:[[0,8],[1,4]]},latencyMs:0},scheduling:{maxConcurrentRequests:1},swipeTimesS:[],rule:{activeBufferTargetSegments:2}};
  const result=new SFVSimulationController({dataset,rule:new SFVCurrentVideoRule(),config}).run();
  assert.ok(result.requests.length>2);
  assert.ok(result.events.some(e=>e.eventType==='REQUEST_QUEUED'));
  assert.ok(result.requests.some(r=>r.state==='COMPLETED'));
  assert.ok(result.sessionRecord.session_summary.initial_playback_delay_s>=0);
});
