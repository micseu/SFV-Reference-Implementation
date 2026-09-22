import test from 'node:test';import assert from 'node:assert/strict';import {SFVConstantRateTransport} from '../src/simulation/SFVConstantRateTransport.js';
test('constant-rate single 8 Mbit request completes in 1s after zero latency',()=>{const t=new SFVConstantRateTransport({capacityMbps:8,latencyMs:0});t.start({requestId:'a',resource:{resourceType:'media'},bytesTotal:1_000_000},0);assert.equal(t.nextEventTime(),1);const e=t.advanceTo(1);assert.ok(e.some(x=>x.eventType==='REQUEST_COMPLETED'));});
test('two equal requests share capacity',()=>{const t=new SFVConstantRateTransport({capacityMbps:8,latencyMs:0});t.start({requestId:'a',resource:{},bytesTotal:1_000_000},0);t.start({requestId:'b',resource:{},bytesTotal:1_000_000},0);assert.equal(t.nextEventTime(),2);t.advanceTo(2);assert.equal(t.get('a').state,'COMPLETED');assert.equal(t.get('b').state,'COMPLETED');});
test('abort enters cancelling and accounts configured tail',()=>{const t=new SFVConstantRateTransport({capacityMbps:8,latencyMs:0,cancelTailBytes:1000,cancelTailMs:100});t.start({requestId:'a',resource:{},bytesTotal:1_000_000},0);t.advanceTo(0.2);assert.equal(t.abort('a',0.2),true);assert.equal(t.get('a').state,'CANCELLING');t.advanceTo(0.3);assert.equal(t.get('a').state,'CANCELLED');assert.equal(t.get('a').finalBytesDelivered-t.get('a').bytesDeliveredAtAbort,1000);});

test('multiple aborts at the same timestamp advance delivered bytes only once',()=>{
  const t=new SFVConstantRateTransport({capacityMbps:8,latencyMs:0,cancelTailBytes:0,cancelTailMs:10});
  t.start({requestId:'a',resource:{resourceType:'media'},bytesTotal:1_000_000},0);
  t.start({requestId:'b',resource:{resourceType:'media'},bytesTotal:1_000_000},0);
  assert.equal(t.abort('a',0.1),true);
  assert.equal(t.abort('b',0.1),true);
  assert.equal(Math.round(t.get('a').bytesDeliveredAtAbort),50_000);
  assert.equal(Math.round(t.get('b').bytesDeliveredAtAbort),50_000);
});
