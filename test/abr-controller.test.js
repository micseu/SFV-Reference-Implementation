import test from 'node:test';
import assert from 'node:assert/strict';
import { SFVAbrController } from '../src/core/SFVAbrController.js';
import { SFVObservationStore } from '../src/core/SFVObservationStore.js';

function makeRule(counter) {
  return {
    name:'CountingRule',
    reset(){},
    onObservationBatch(events){counter.batches.push(events.map(e=>e.eventType));},
    getSwitchRequest(){counter.decisions+=1;return {rule:'CountingRule',actions:[]};},
    getState(){return null;}
  };
}

function makeController(requestProgressTriggers,counter){
  return new SFVAbrController({
    rule:makeRule(counter),
    dispatch:()=>{},
    contextFactory:()=>({getCurrentTime:()=>1}),
    observationStore:new SFVObservationStore(),
    requestProgressTriggers
  });
}

test('request progress is logged but does not trigger by default',()=>{
  const counter={decisions:0,batches:[]};
  const controller=makeController(false,counter);
  controller.reset();
  controller.observe({time:1,eventType:'REQUEST_PROGRESS',triggerDecision:true});
  assert.equal(controller.decideIfNeeded({requests:[],store:[],catalogState:()=>null}),null);
  assert.equal(counter.decisions,0);
  controller.observe({time:1,eventType:'REQUEST_COMPLETED',triggerDecision:true});
  controller.decideIfNeeded({requests:[],store:[],catalogState:()=>null});
  assert.equal(counter.decisions,1);
  assert.deepEqual(counter.batches[0],['REQUEST_PROGRESS','REQUEST_COMPLETED']);
});

test('request progress can be configured as a decision trigger',()=>{
  const counter={decisions:0,batches:[]};
  const controller=makeController(true,counter);
  controller.reset();
  controller.observe({time:1,eventType:'REQUEST_PROGRESS',triggerDecision:true});
  controller.decideIfNeeded({requests:[],store:[],catalogState:()=>null});
  assert.equal(counter.decisions,1);
  assert.deepEqual(counter.batches[0],['REQUEST_PROGRESS']);
});

test('ABORT actions are dispatched before fetch actions from the same batch',()=>{
  const dispatched=[];
  const store=new SFVObservationStore();
  const rule={
    name:'OrderingRule', reset(){}, onObservationBatch(){}, getState(){return null;},
    getSwitchRequest(){return {rule:'OrderingRule',actions:[
      {actionType:'FETCH_MANIFEST',videoId:'v2'},
      {actionType:'ABORT',requestId:'old-r'}
    ]};}
  };
  const controller=new SFVAbrController({
    rule,
    dispatch:(actions)=>dispatched.push(...actions),
    contextFactory:()=>({getCurrentTime:()=>2}),
    observationStore:store
  });
  controller.reset();
  controller.observe({time:2,eventType:'SWIPE'});
  const result=controller.decideIfNeeded({
    requests:[{requestId:'old-r',state:'ACTIVE',resource:{videoId:'v1',resourceType:'media',segmentIndex:0}}],
    store:[],
    catalogState:(videoId)=>videoId==='v2'?'UNKNOWN':'AVAILABLE'
  });
  assert.deepEqual(result.actions.map((a)=>a.actionType),['ABORT','FETCH_MANIFEST']);
  assert.deepEqual(dispatched.map((a)=>a.actionType),['ABORT','FETCH_MANIFEST']);
});

test('invalid action batches are rejected atomically and logged',()=>{
  let dispatchCalls=0;
  const store=new SFVObservationStore();
  const rule={
    name:'InvalidRule', reset(){}, onObservationBatch(){}, getState(){return null;},
    getSwitchRequest(){return {rule:'InvalidRule',actions:[
      {actionType:'FETCH_MANIFEST',videoId:'v2'},
      {actionType:'FETCH_MEDIA',videoId:'v3',mediaType:'video',representationId:'0',segmentIndex:0}
    ]};}
  };
  const controller=new SFVAbrController({
    rule,
    dispatch:()=>{dispatchCalls+=1;},
    contextFactory:()=>({getCurrentTime:()=>3}),
    observationStore:store
  });
  controller.reset();
  controller.observe({time:3,eventType:'VIDEO_ACTIVATED'});
  assert.throws(()=>controller.decideIfNeeded({
    requests:[], store:[], catalogState:()=> 'UNKNOWN'
  }),/Manifest unavailable v3/);
  assert.equal(dispatchCalls,0);
  assert.equal(controller.decisionCount,0);
  const rejected=store.list().find((event)=>event.eventType==='SFV_ACTION_REJECTED');
  assert.ok(rejected);
  assert.match(rejected.reason,/Manifest unavailable v3/);
});
