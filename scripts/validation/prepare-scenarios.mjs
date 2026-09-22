import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateBrowserExperimentConfig} from '../../src/browser/SFVBrowserExperimentConfig.js';
import {validateExperimentSpec} from '../../src/experiment/SFVExperimentSpec.js';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const DEFAULT=path.join(root,'scenarios/validation/scenario-b1-v1.json');
const clone=value=>structuredClone(value);
const assert=(condition,message)=>{if(!condition)throw new TypeError(message);};
function validateScenario(s){
  assert(s?.schemaVersion===1,'scenario.schemaVersion must be 1');
  assert(typeof s.scenarioId==='string'&&/^[a-zA-Z0-9_-]+$/.test(s.scenarioId),'Invalid scenarioId');
  assert(Number.isSafeInteger(s.seed)&&s.seed>=0,'Invalid seed');
  assert(Array.isArray(s.playlist)&&s.playlist.length>=3&&s.playlist.every(id=>['v1','v2','v3'].includes(id))&&new Set(s.playlist).size===s.playlist.length,'Use unique fixture videos v1/v2/v3');
  assert(Array.isArray(s.swipeTimesS)&&s.swipeTimesS.length===2&&s.swipeTimesS.every((t,i)=>Number.isFinite(t)&&t>0&&(i===0||t>s.swipeTimesS[i-1])),'Two strictly increasing swipe times are required');
  assert(Number.isFinite(s.sessionDurationS)&&s.sessionDurationS>s.swipeTimesS.at(-1),'Session must end after swipes');
  assert(Number.isSafeInteger(s.maxConcurrentRequests)&&s.maxConcurrentRequests>=1,'Invalid local request limit');
  assert(s.cacheMaxBytes===null||(Number.isSafeInteger(s.cacheMaxBytes)&&s.cacheMaxBytes>=0),'Invalid cacheMaxBytes');
  assert(Array.isArray(s.capacityTrace) && s.capacityTrace.length >= 2 &&
    s.capacityTrace.every((entry,i) => Array.isArray(entry) && entry.length === 2 &&
      Number.isFinite(entry[0]) && entry[0] >= 0 && Number.isFinite(entry[1]) && entry[1] >= 0 &&
      (i === 0 ? entry[0] === 0 : entry[0] > s.capacityTrace[i-1][0])),
  'Scenario capacityTrace must have strictly increasing nonnegative [timeS, Mbps] steps starting at 0');
  if (s.diagnostics !== undefined) {
    assert(s.diagnostics && typeof s.diagnostics === 'object' && !Array.isArray(s.diagnostics) &&
      Object.keys(s.diagnostics).every(k=>k==='abrDecisions') &&
      (s.diagnostics.abrDecisions===undefined || typeof s.diagnostics.abrDecisions==='boolean'),
    'diagnostics.abrDecisions must be boolean');
  }
  if (s.stallValidation !== undefined) {
    const expected = s.stallValidation;
    assert(expected && typeof expected === 'object' && !Array.isArray(expected), 'stallValidation must be an object');
    assert(Number.isSafeInteger(expected.minRecoveredStalls) && expected.minRecoveredStalls > 0,
      'stallValidation.minRecoveredStalls must be a positive integer');
    assert(Array.isArray(expected.expectedStallVideoIds) && expected.expectedStallVideoIds.length > 0 &&
      new Set(expected.expectedStallVideoIds).size === expected.expectedStallVideoIds.length &&
      expected.expectedStallVideoIds.every(id => s.playlist.includes(id)),
    'stallValidation.expectedStallVideoIds must refer to distinct playlist videos');
    assert(Number.isFinite(expected.minStallDurationS) && expected.minStallDurationS > 0,
      'stallValidation.minStallDurationS must be positive');
  }
  for(const [name,value] of Object.entries(s.comparison??{}))assert(name.endsWith('ToleranceS')&&Number.isFinite(value)&&value>0,`Invalid comparison tolerance ${name}`);
  return clone(s);
}
/** Ensure simulated resource descriptors use the exact video-only browser fixture bytes. */
export function fixtureAlignedDataset(source=JSON.parse(fs.readFileSync(path.join(root,'fixtures/content/content.json'),'utf8'))){
  const dataset=clone(source);
  for(const video of dataset.videos){
    const filename=path.join(root,'fixtures/dash',video.videoId,'manifest-video-only.mpd');
    video.manifestUrl=`/media/${video.videoId}/manifest-video-only.mpd`;
    video.manifestBytes=fs.statSync(filename).size;
    delete video.representations.audio;
    for(const rep of video.representations.video){
      const disk=path.join(root,'fixtures/dash',video.videoId);
      const local=url=>path.join(disk,path.basename(url));
      assert(fs.statSync(local(rep.initUrl)).size===rep.initBytes,`Fixture init-byte mismatch ${video.videoId}/${rep.id}`);
      for(const segment of rep.segments)assert(fs.statSync(local(segment.url)).size===segment.bytes,`Fixture segment-byte mismatch ${video.videoId}/${rep.id}/${segment.index}`);
    }
  }
  return dataset;
}
export function prepareScenarios(raw){
  const s=validateScenario(raw), dataset=fixtureAlignedDataset();
  const browser=validateBrowserExperimentConfig({
    schemaVersion:1,experimentId:`${s.scenarioId}-browser`,seed:s.seed,
    abr:clone(s.abr),playlist:clone(s.playlist),
    userModel:{type:'sequence',swipeTimesS:clone(s.swipeTimesS),sessionDurationS:s.sessionDurationS},
    network:{capacityTrace:clone(s.capacityTrace),latencyMs:s.latencyMs},
    cache:{maxBytes:s.cacheMaxBytes},scheduling:{maxConcurrentRequests:s.maxConcurrentRequests,swipeCancellation:true},
    requestRetry:{maxRetries:0,delayMs:250},
    diagnostics:{abrDecisions:s.diagnostics?.abrDecisions??false}
  });
  const session=(index)=>({abr:clone(s.abr),config:{
    sessionId:`validation-ue-${index}`,ueId:index,seed:s.seed,maxTimeS:s.sessionDurationS+1,
    sessionStartTimeS:0,sessionDurationS:s.sessionDurationS,
    userModel:{type:'sequence',swipeTimesS:clone(s.swipeTimesS)},
    scheduling:{maxConcurrentRequests:s.maxConcurrentRequests,swipeCancellation:true},
    cache:s.cacheMaxBytes===null?{}:{maxBytes:s.cacheMaxBytes},requestRetry:{maxRetries:0,delayS:0.25},
    diagnostics:{abrDecisions:s.diagnostics?.abrDecisions??false}
  }});
  const base={schemaVersion:1,experimentId:s.scenarioId,content:{dataset,playlist:clone(s.playlist)},
    network:{capacityTrace:clone(s.capacityTrace),latencyMs:s.latencyMs},
    sessions:[session(0)]};
  const one=validateExperimentSpec({...base,experimentId:`${s.scenarioId}-one`});
  const two=validateExperimentSpec({...base,experimentId:`${s.scenarioId}-two`,sessions:[session(0),session(1)]});
  return {scenario:s,browser,one,two};
}
export function writeScenarioFiles(raw,outputDir){
  const scenarios=prepareScenarios(raw);fs.mkdirSync(outputDir,{recursive:true});
  for(const [name,value] of Object.entries(scenarios))fs.writeFileSync(path.join(outputDir,`${name}.json`),JSON.stringify(value,null,2)+'\n');
  return scenarios;
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const source=path.resolve(process.argv[2]??DEFAULT);
  const target=path.resolve(process.argv[3]??path.join(root,'out/validation-b1/configs'));
  try{writeScenarioFiles(JSON.parse(fs.readFileSync(source,'utf8')),target);console.log(`Generated versioned browser/one-UE/two-UE configurations in ${target}`);}
  catch(error){console.error(error.stack??String(error));process.exitCode=1;}
}
