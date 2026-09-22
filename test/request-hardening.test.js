import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {SFVBrowserRequestManager} from '../src/dashjs/SFVBrowserRequestManager.js';
import {SFVHttpTransport} from '../src/dashjs/SFVHttpTransport.js';
import {SFVSegmentStore} from '../src/media/SFVSegmentStore.js';
import {SFVMediaNetworkEmulator} from '../scripts/network/SFVMediaNetworkEmulator.mjs';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const resource={videoId:'v1',resourceType:'media',mediaType:'video',representationId:'0',segmentIndex:0,startS:0,durationS:2};
const action={...resource,actionType:'FETCH_MEDIA'};
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const until=async check=>{for(let i=0;i<200;i++){if(check())return;await delay(10);}assert.fail('Timed out awaiting terminal request');};
const listen=async handler=>{const server=http.createServer(handler);await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  return {server,url:`http://127.0.0.1:${server.address().port}/test.m4s`,close:()=>new Promise(resolve=>server.close(resolve))};};
const managerFor=(url,options={})=>new SFVBrowserRequestManager({catalog:{getResourceDescriptor:descriptor=>({...resource,...descriptor,url})},
  store:new SFVSegmentStore(options.cache??{}),transport:options.transport??new SFVHttpTransport(options.http??{}),
  retry:options.retry??{},maxConcurrentRequests:options.maxConcurrentRequests??Infinity,
  onEvent:options.onEvent??(()=>{}),now:()=>performance.now()/1000});

test('HTTP 404 is terminal even when transient retries are enabled',async t=>{
  let hits=0;const httpServer=await listen((_req,res)=>{hits++;res.writeHead(404);res.end('missing');});
  t.after(()=>httpServer.close());
  const manager=managerFor(httpServer.url,{retry:{maxRetries:3,delayMs:5}});t.after(()=>manager.reset());
  const id=manager.dispatch(action);await until(()=>manager.get(id).state==='FAILED');await delay(60);
  assert.equal(hits,1);assert.equal(manager.list().length,1);
});

test('truncated HTTP response is a failed transfer, never a cached segment',async t=>{
  const httpServer=await listen((_req,res)=>{res.writeHead(200,{'content-length':'1000'});res.write(Buffer.alloc(200));
    setTimeout(()=>res.destroy(),20);});t.after(()=>httpServer.close());
  const events=[];const manager=managerFor(httpServer.url,{onEvent:e=>events.push(e)});t.after(()=>manager.reset());
  const id=manager.dispatch(action);await until(()=>manager.get(id).state==='FAILED');
  assert.equal(manager.store.get(resource),null);
  assert.ok(events.some(e=>e.eventType==='REQUEST_FAILED'));
  assert.equal(events.some(e=>e.eventType==='RESOURCE_CACHED'),false);
});

test('browser cancellation accounts only observed tail bytes, terminates once and releases the UE slot',async()=>{
  let resolveFirst;let rejectFirst;const started=[];
  const transport={onEvent:null,start({requestId}){started.push(requestId);
    if(started.length===1){this.onEvent({eventType:'REQUEST_PROGRESS',requestId,totalBytes:10});
      return new Promise((resolve,reject)=>{resolveFirst=resolve;rejectFirst=reject;});}
    return Promise.resolve(new Uint8Array(3).buffer);},
  abort(requestId){this.onEvent({eventType:'REQUEST_PROGRESS',requestId,totalBytes:15});
    rejectFirst(Object.assign(new Error('aborted'),{name:'AbortError'}));},reset(){}};
  const manager=managerFor('http://example.invalid/test.m4s',{transport,maxConcurrentRequests:1});
  const first=manager.dispatch(action);
  const second=manager.dispatch({...action,segmentIndex:1});
  assert.equal(manager.get(second).state,'QUEUED');
  assert.equal(manager.abort(first),true);
  await until(()=>manager.get(first).state==='CANCELLED'&&manager.get(second).state==='COMPLETED');
  assert.equal(manager.get(first).bytesDeliveredAtAbort,10);
  assert.equal(manager.get(first).finalBytesDelivered,15);
  assert.equal(manager.get(first).finalBytesDelivered-manager.get(first).bytesDeliveredAtAbort,5);
  assert.equal(started.length,2);
  assert.equal(manager.abort(first),false);
  void resolveFirst;manager.reset();
});

test('retry reservation is visible as QUEUED and can be cancelled without an extra HTTP request',async t=>{
  let hits=0;const httpServer=await listen((_req,res)=>{hits++;res.writeHead(503);res.end('failure');});t.after(()=>httpServer.close());
  const manager=managerFor(httpServer.url,{retry:{maxRetries:1,delayMs:500}});t.after(()=>manager.reset());
  const original=manager.dispatch(action);
  await until(()=>manager.list().some(r=>r.state==='QUEUED'&&r.requestId.startsWith('browser-retry-pending')));
  const pending=manager.list().find(r=>r.state==='QUEUED');
  assert.equal(pending.resource.segmentIndex,0);
  assert.equal(manager.abort(pending.requestId),true);
  assert.equal(manager.get(original).state,'FAILED');await delay(520);
  assert.equal(hits,1);
});

test('zero-capacity HTTP trace pauses a transfer until the capacity step changes',async t=>{
  const emulator=new SFVMediaNetworkEmulator({tickMs:10});
  emulator.configure({capacityTrace:[[0,0],[0.12,10]]});
  const filePath=path.join(root,'fixtures/dash/v1/chunk-0-00001.m4s');
  const server=http.createServer((req,res)=>emulator.serve(req,res,{filePath,pathname:'/media/v1/segment.m4s'}));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{emulator.close();await new Promise(resolve=>server.close(resolve));});
  const start=performance.now();
  const response=await fetch(`http://127.0.0.1:${server.address().port}/media/v1/segment.m4s`);
  const result=await response.arrayBuffer();
  assert.equal(result.byteLength,fs.statSync(filePath).size);
  assert.ok(performance.now()-start>=90,'no bytes should be sent before the capacity grant');
});

test('session-end drain settles active and queued browser requests before taking the result',async()=>{
  let rejectFirst;let starts=0;
  const transport={onEvent:null,start({requestId}){starts++;
    return new Promise((_resolve,reject)=>{rejectFirst=reject;});},
    abort(){rejectFirst(Object.assign(new Error('aborted'),{name:'AbortError'}));},reset(){}};
  const manager=managerFor('http://example.invalid/test.m4s',{transport,maxConcurrentRequests:1});
  const first=manager.dispatch(action);
  const second=manager.dispatch({...action,segmentIndex:1});
  manager.cancelAll('SESSION_END');
  assert.equal(await manager.waitForTerminal({timeoutMs:500}),true);
  assert.equal(manager.get(first).state,'CANCELLED');
  assert.equal(manager.get(second).state,'CANCELLED');
  assert.equal(starts,1,'queued request must not reach the HTTP transport');
  manager.reset();
});
