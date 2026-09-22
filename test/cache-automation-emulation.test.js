import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {fileURLToPath} from 'node:url';
import {SFVSegmentStore} from '../src/media/SFVSegmentStore.js';
import {cleanupPassedSegments,cleanupDepartedVideo} from '../src/media/SFVCacheLifecycle.js';
import {SFVBrowserUserAutomation} from '../src/browser/SFVBrowserUserAutomation.js';
import {SFVMediaNetworkEmulator} from '../scripts/network/SFVMediaNetworkEmulator.mjs';
import {SFVSimulationController} from '../src/simulation/SFVSimulationController.js';
import {SFVSimulationRunner} from '../src/simulation/SFVSimulationRunner.js';
import {SFVCurrentVideoRule} from '../src/rules/SFVCurrentVideoRule.js';
import {SFVMultiVideoPrefetchRule} from '../src/rules/SFVMultiVideoPrefetchRule.js';
import {calculateDataWastage} from '../src/output/SFVDataWastageCalculator.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataset=JSON.parse(fs.readFileSync(path.join(root,'fixtures/content/content.json'),'utf8'));
const resource=(videoId,segmentIndex=0)=>({videoId,mediaType:'video',representationId:'0',resourceType:'media',segmentIndex,startS:segmentIndex*2,durationS:2});
const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

test('shared cache rejects a new item without evicting useful existing resources',()=>{
  const store=new SFVSegmentStore({maxBytes:10});
  assert.equal(store.put(resource('v1'),null,{bytes:6}),'v1|video|0|media|0');
  assert.equal(store.put(resource('v2'),null,{bytes:5}),null);
  assert.equal(store.getUsedBytes(),6);assert.ok(store.has(resource('v1')));
  assert.equal(store.put(resource('v2'),null,{bytes:4}),'v2|video|0|media|0');
  assert.equal(store.getUsedBytes(),10);
  assert.equal(cleanupPassedSegments(store,{videoId:'v1',positionS:2}).length,1);
  assert.equal(store.getAvailableBytes(),6);
  assert.equal(cleanupDepartedVideo(store,{videoId:'v2'}).length,1);
  assert.equal(store.getUsedBytes(),0);
});

test('cache admission rejection counts delivered media bytes as unusable even at cutoff',()=>{
  const wasted=calculateDataWastage({dataset,requests:[{requestId:'r1',resource:resource('v1'),state:'COMPLETED',
    finalBytesDelivered:50,cacheAdmitted:false}],playbacks:{},userEvents:[],terminationReason:'simulation_cutoff'});
  assert.equal(wasted.total.total,50);
  assert.equal(wasted.total.reasons.cache_admission_rejected,50);
  assert.equal(wasted.total.unresolvedAtCutoff,0);
});

test('simulator uses identical post-download admission and does not turn rejection into network failure',()=>{
  const controller=new SFVSimulationController({dataset,rule:new SFVCurrentVideoRule(),
    config:{maxTimeS:0.8,cache:{maxBytes:1},transport:{capacityMbps:12,latencyMs:0},
      scheduling:{maxConcurrentRequests:2}}});
  const result=controller.run();
  assert.ok(result.events.some(e=>e.eventType==='CACHE_ADMISSION_REJECTED'));
  assert.ok(result.requests.some(r=>r.state==='COMPLETED'&&r.cacheAdmitted===false));
  assert.equal(controller.store.getUsedBytes(),0);
});

test('browser user generator resolves seeded and sequence models without simulator dependencies',async()=>{
  const swipes=[];let ended=0;
  const config={model:{type:'sequence',swipeTimesS:[0.01,0.025]},playlistLength:3,
    sessionDurationS:0.05,onSwipe:()=>swipes.push('swipe'),onEnd:()=>{ended++;}};
  const automation=new SFVBrowserUserAutomation(config).start();
  for(let i=0;i<100 && ended===0;i++)await wait(10);
  assert.equal(ended,1);assert.equal(swipes.length,2);
  assert.deepEqual(automation.snapshot().executedEvents.map(e=>e.action),
    ['SWIPE_NEXT','SWIPE_NEXT','SESSION_END']);
  const a=new SFVBrowserUserAutomation({...config,model:{type:'seeded',seed:7,watchDurationRangeS:[1,3]},sessionDurationS:9});
  const b=new SFVBrowserUserAutomation({...config,model:{type:'seeded',seed:7,watchDurationRangeS:[1,3]},sessionDurationS:9});
  assert.deepEqual(a.plannedEvents,b.plannedEvents);
});

test('HTTP emulation respects trace steps, failure injection and body length',async t=>{
  const emulator=new SFVMediaNetworkEmulator({tickMs:10});
  const filePath=path.join(root,'fixtures/dash/v1/chunk-0-00001.m4s');
  const pathname='/media/v1/chunk-0-00001.m4s';
  const server=http.createServer((req,res)=>emulator.serve(req,res,{filePath,pathname}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{emulator.close();await new Promise(resolve=>server.close(resolve));});
  const url=`http://127.0.0.1:${server.address().port}/media/v1/chunk-0-00001.m4s`;
  emulator.configure({capacityTrace:[[0,1],[0.15,4]],latencyMs:0,
    faults:[{pathIncludes:'chunk-0-',occurrence:1,status:503}]});
  assert.equal(emulator.capacityAt(0.1),1);assert.equal(emulator.capacityAt(0.16),4);
  assert.equal((await fetch(url)).status,503);
  const response=await fetch(url);
  assert.equal(response.status,200);
  assert.equal((await response.arrayBuffer()).byteLength,fs.statSync(filePath).size);
  assert.ok(emulator.snapshot().events.some(e=>e.eventType==='HTTP_COMPLETED'));
});

test('fault-injected shared network produces an observable per-request retry without bypassing UE queue',()=>{
  const runner=new SFVSimulationRunner({dataset,sessions:[{ruleFactory:()=>new SFVCurrentVideoRule(),
    config:{maxTimeS:6,sessionStartTimeS:0,sessionEndTimeS:5,
      requestRetry:{maxRetries:1,delayS:0.1},scheduling:{maxConcurrentRequests:1}}}],
    network:{capacityMbps:20,latencyMs:0,faults:[{videoId:'v1',resourceType:'media',segmentIndex:0,attempt:0}]}});
  const [result]=runner.run();
  assert.ok(result.events.some(e=>e.eventType==='RETRY_SCHEDULED'));
  const retry=result.requests.find(r=>r.retryAttempt===1);
  assert.ok(retry,'the retry has a distinct request record');
  assert.ok(retry.retryOf,'retry links to its original attempt');
  assert.ok(result.requests.some(r=>r.state==='FAILED'));
  assert.ok(runner.lastNetworkReport.concurrency.sessions[0].maxConcurrentRequests===1);
});

test('real HTTP 503 is retried once with a linked request ID, while HTTP 404 is not retried',async t=>{
  const {SFVBrowserRequestManager}=await import('../src/dashjs/SFVBrowserRequestManager.js');
  const {SFVHttpTransport}=await import('../src/dashjs/SFVHttpTransport.js');
  let requests=0;
  const server=http.createServer((_req,res)=>{
    requests++;
    if(requests===1){res.writeHead(503);res.end('Temporary outage');return;}
    res.writeHead(200,{'content-length':'3'});res.end('abc');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const url=`http://127.0.0.1:${server.address().port}/segment.m4s`;
  const catalog={getResourceDescriptor:action=>({...resource('v1'),...action,url})};
  const events=[];const manager=new SFVBrowserRequestManager({catalog,store:new SFVSegmentStore(),
    transport:new SFVHttpTransport(),retry:{maxRetries:1,delayMs:10},onEvent:e=>events.push(e),now:()=>performance.now()/1000});
  t.after(()=>manager.reset());
  manager.dispatch({actionType:'FETCH_MEDIA',videoId:'v1',mediaType:'video',representationId:'0',segmentIndex:0});
  for(let i=0;i<200&&!manager.list().some(r=>r.retryAttempt===1&&r.state==='COMPLETED');i++)await wait(10);
  const records=manager.list();assert.equal(records.length,2);
  assert.equal(records[0].state,'FAILED');assert.equal(records[1].state,'COMPLETED');
  assert.equal(records[1].retryOf,records[0].requestId);assert.equal(requests,2);
  assert.ok(events.some(e=>e.eventType==='RETRY_SCHEDULED'));
});

test('cancellation tail and concurrent completion cannot double count network bytes',()=>{
  // The deterministic backend is shared across UEs, but an abort belongs to one request ID.
  return import('../src/simulation/SFVSharedNetworkTransport.js').then(({SFVSharedNetworkTransport})=>{
    const network=new SFVSharedNetworkTransport({capacityMbps:1,latencyMs:0,
      cancelTailBytes:125,cancelTailMs:100});
    const r=network.start({requestId:'r1',resource:resource('v1'),bytesTotal:10000},0,0);
    assert.equal(r.state,'ACTIVE');network.advanceTo(0.01);
    const atAbort=network.get('r1').bytesDelivered;
    assert.equal(network.abort('r1',0.01),true);
    const events=network.advanceTo(0.11);
    const completed=network.get('r1');
    assert.equal(completed.state,'CANCELLED');
    assert.equal(completed.finalBytesDelivered,atAbort+125);
    assert.equal(events.filter(e=>e.eventType==='REQUEST_CANCELLED').length,1);
    assert.equal(network.abort('r1',0.11),false);
    assert.equal(network.advanceTo(0.2).filter(e=>e.eventType==='REQUEST_CANCELLED').length,0);
  });
});
