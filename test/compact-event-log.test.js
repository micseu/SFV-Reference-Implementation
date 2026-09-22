import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {buildCompactEventLog,formatCompactEventLog} from '../src/output/SFVCompactEventLog.js';
import {SFVMediaNetworkEmulator} from '../scripts/network/SFVMediaNetworkEmulator.mjs';
import {networkCapacityEvents,writeCompactEventArtifacts} from '../scripts/compact-event-artifacts.mjs';
import {SFVSimulationController} from '../src/simulation/SFVSimulationController.js';
import {SFVCurrentVideoRule} from '../src/rules/SFVCurrentVideoRule.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dataset=JSON.parse(fs.readFileSync(path.join(root,'fixtures/content/content.json'),'utf8'));

test('compact formatter maps user, network, player, cache, ABR events without mutating raw data',()=>{
  const events=[
    {eventId:1,time:0,eventType:'SESSION_STARTED'},
    {eventId:2,time:0.15,eventType:'REQUEST_STARTED',requestId:'r1',resource:{resourceType:'manifest',videoId:'v1'}},
    {eventId:3,time:0.25,eventType:'RULE_DECISION',rule:'B1',actions:[{actionType:'FETCH_MEDIA'}]},
    {eventId:4,time:1,eventType:'PLAYBACK_STARTED',videoId:'v1'},
    {eventId:5,time:2,eventType:'STALL_STARTED',videoId:'v1'},
    {eventId:6,time:3,eventType:'STALL_RECOVERED',videoId:'v1'},
    {eventId:7,time:4,eventType:'SWIPE',fromVideoId:'v1',toVideoId:'v2'},
    {eventId:8,time:4.5,eventType:'CACHE_ADMISSION_REJECTED',resource:{resourceType:'media',videoId:'v2',segmentIndex:1}}
  ];
  const original=structuredClone(events);
  const record={session_id:'ue-1',ue_id:1,playback_metrics:{quality_transitions:[
    {at_s:3.2,scope:'within_video',video_id:'v1',from_video_id:'v1',to_video_id:'v1',
      from_representation_id:'0',to_representation_id:'2',from_bitrate_kbps:300,to_bitrate_kbps:650,is_quality_change:true},
    {at_s:4.6,scope:'between_videos',video_id:'v2',from_video_id:'v1',to_video_id:'v2',
      from_representation_id:'2',to_representation_id:'2',from_bitrate_kbps:650,to_bitrate_kbps:650,is_quality_change:false}
  ]}};
  const log=buildCompactEventLog({events,sessionRecord:record,networkEvents:[
    {eventType:'EMULATION_STARTED',time:0,capacityMbps:8},
    {eventType:'NETWORK_CAPACITY_CHANGED',time:2.5,capacityMbps:2}],clockOrigin:'session_start'});
  assert.equal(log.schemaVersion,1);
  assert.equal(log.clockOrigin,'session_start');
  assert.equal(log.sessionId,'ue-1');
  assert.ok(log.events.some(e=>e.source==='Network'&&e.details.includes('manifest')));
  assert.ok(log.events.some(e=>e.source==='Network'&&e.eventType==='NETWORK_CAPACITY_CHANGED'&&e.details.includes('2 Mbit/s')));
  assert.ok(log.events.some(e=>e.source==='Player'&&e.eventType==='QUALITY_SWITCH'&&e.timestampS===3.2));
  assert.ok(log.events.some(e=>e.eventType==='VIDEO_QUALITY_TRANSITION'&&e.details.includes('same bitrate')));
  assert.ok(log.events.some(e=>e.eventType==='SWIPE'&&e.source==='User'));
  assert.ok(log.events.some(e=>e.eventType==='CACHE_ADMISSION_REJECTED'&&e.source==='Cache'));
  assert.ok(log.events.every((e,i,a)=>i===0||a[i-1].timestampS<=e.timestampS));
  assert.match(formatCompactEventLog(log),/QUALITY_SWITCH/);
  assert.deepEqual(events,original);
});

test('HTTP capacity changes are logged when a trace boundary passes even without active downloads',()=>{
  let now=100;
  const emulator=new SFVMediaNetworkEmulator({now:()=>now});
  emulator.configure({capacityTrace:[[0,8],[2,3],[4,5]]});
  now=103;
  assert.deepEqual(emulator.snapshot().events.map(e=>[e.eventType,e.atS,e.capacityMbps]),[
    ['EMULATION_STARTED',0,8],['NETWORK_CAPACITY_CHANGED',2,3]]);
  now=105;
  assert.equal(emulator.snapshot().events.filter(e=>e.eventType==='NETWORK_CAPACITY_CHANGED').length,2);
  assert.equal(emulator.snapshot().events.filter(e=>e.eventType==='NETWORK_CAPACITY_CHANGED').length,2);
  emulator.close();
});

test('simulation produces the same compact schema and exports both text and JSON without losing the raw result',()=>{
  const result=new SFVSimulationController({dataset,rule:new SFVCurrentVideoRule(),
    config:{maxTimeS:4,swipeTimesS:[2],transport:{capacityMbps:4,latencyMs:40}}}).run();
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sfv-compact-'));
  try{
    const {log,jsonName,textName}=writeCompactEventArtifacts({result,outputDirectory:dir,prefix:'ue0',
      networkEvents:networkCapacityEvents({capacityTrace:[[0,4],[1,2]],events:[
        {time:1,eventType:'NETWORK_CAPACITY_CHANGED',capacityMbps:2}]},result.timeS)});
    assert.ok(fs.existsSync(path.join(dir,jsonName)));
    assert.ok(fs.existsSync(path.join(dir,textName)));
    assert.ok(fs.existsSync(path.join(dir,textName)));
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir,jsonName),'utf8')),log);
    assert.equal(log.clockOrigin,'experiment_start');
    assert.ok(log.events.some(e=>e.eventType==='SESSION_STARTED'));
    assert.ok(log.events.some(e=>e.eventType==='NETWORK_CAPACITY_CHANGED'));
    assert.ok(log.events.some(e=>e.source==='Player'&&e.eventType==='PLAYBACK_STARTED'));
    assert.ok(Array.isArray(result.requests));
    assert.ok(Array.isArray(result.events));
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('browser demo supplies live event panel, copy and full JSON export with full export support',()=>{
  const html=fs.readFileSync(path.join(root,'browser/index.html'),'utf8');
  const main=fs.readFileSync(path.join(root,'browser/main.js'),'utf8');
  assert.match(html,/id="event-log"/);
  assert.match(html,/id="copy-event-log"/);
  assert.match(html,/id="export"[^>]*>Download Full Session JSON/);
  assert.match(main,/result\.compactEventLog=compactLog\(result\)/);
  assert.match(main,/navigator\.clipboard\.writeText\(lastCompactText\)/);
});
