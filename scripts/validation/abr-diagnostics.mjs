import fs from 'node:fs';
import {SFVCurrentVideoRule} from '../../src/rules/SFVCurrentVideoRule.js';
import {SFVMultiVideoPrefetchRule} from '../../src/rules/SFVMultiVideoPrefetchRule.js';
import {replayRecordedDecision} from '../../src/core/SFVDecisionDiagnostics.js';

const classes=new Map([
  ['SFVCurrentVideoRule',SFVCurrentVideoRule],
  ['SFVMultiVideoPrefetchRule',SFVMultiVideoPrefetchRule]
]);

export function replaySessionDecisions(session) {
  const records=(session.events??[]).filter(event=>event.eventType==='ABR_DECISION_DIAGNOSTIC');
  if(!records.length) return {status:'missing-diagnostics',total:0,passed:0,failures:[],
    note:'This session was recorded without diagnostics. Rerun with diagnostics.abrDecisions=true.'};
  const failures=[];
  for(const event of records){
    const record=event.diagnostic;
    const Rule=classes.get(record?.rule);
    if(!Rule){failures.push({eventId:event.eventId,timeS:event.time,rule:record?.rule,
      error:'Rule class not registered for replay; register its ORIGINAL JavaScript class.'});continue;}
    try{const result=replayRecordedDecision(record,Rule);
      if(!result.passed)failures.push({eventId:event.eventId,timeS:event.time,
        videoId:record.context?.currentVideo?.videoId,expected:result.expected,actual:result.actual});
    }catch(error){failures.push({eventId:event.eventId,timeS:event.time,error:error.message});}
  }
  return {status:failures.length?'replay-failed':'replay-passed',total:records.length,
    passed:records.length-failures.length,failures};
}

function firstActiveMediaPerVideo(session) {
  const found=new Map();
  for(const event of session.events??[]){
    if(event.eventType!=='ABR_DECISION_DIAGNOSTIC')continue;
    const d=event.diagnostic;
    const videoId=d?.context?.currentVideo?.videoId;
    if(!videoId||found.has(videoId))continue;
    const action=d.decision?.actions?.find(a=>a.actionType==='FETCH_MEDIA'&&a.videoId===videoId&&a.segmentIndex===0);
    if(!action)continue;
    found.set(videoId,{timeS:d.timeS,selectedRepresentationId:action.representationId,
      safeThroughputKbps:d.safeThroughputKbps,
      throughputSamples:d.throughputSamples,
      pendingRequests:d.context.inFlightRequests?.map(r=>({videoId:r.resource?.videoId,
        resourceType:r.resource?.resourceType,representationId:r.resource?.representationId,
        segmentIndex:r.resource?.segmentIndex,state:r.state}))??[],
      playback:d.context.currentVideo?.playback??null,
      rule:d.rule,reason:d.decision?.reason??null});
  }
  return Object.fromEntries(found);
}

/** Diagnostics are compared as OBSERVATIONS, not assumed to be equal across real and DES clocks. */
export function compareDecisionInputs(browser,simulator) {
  const browserDecisions=firstActiveMediaPerVideo(browser);
  const simulationDecisions=firstActiveMediaPerVideo(simulator);
  const videos=[...new Set([...Object.keys(browserDecisions),...Object.keys(simulationDecisions)])];
  const comparisons=videos.map(videoId=>{
    const b=browserDecisions[videoId]??null,s=simulationDecisions[videoId]??null;
    return {videoId,browser:b,simulation:s,
      sameRepresentation:b!==null&&s!==null&&b.selectedRepresentationId===s.selectedRepresentationId,
      throughputDifferenceKbps:b?.safeThroughputKbps!==null&&s?.safeThroughputKbps!==null&&
        Number.isFinite(b?.safeThroughputKbps)&&Number.isFinite(s?.safeThroughputKbps)
        ?b.safeThroughputKbps-s.safeThroughputKbps:null};
  });
  return {schemaVersion:1,status:videos.length&&comparisons.every(c=>c.sameRepresentation)
    ?'first-active-representations-match':'review-required',
    note:'Compares first active segment-0 decisions and supporting observations per video; does not establish complete event-by-event parity.',
    browserDiagnostics:(browser.events??[]).filter(e=>e.eventType==='ABR_DECISION_DIAGNOSTIC').length,
    simulationDiagnostics:(simulator.events??[]).filter(e=>e.eventType==='ABR_DECISION_DIAGNOSTIC').length,
    comparisons};
}

if(process.argv[1]&&process.argv[1].endsWith('abr-diagnostics.mjs')){
  const [command,first,second,output]=process.argv.slice(2);
  try{
    if(!first||!['replay','compare'].includes(command))throw new Error(
      'Usage: node scripts/validation/abr-diagnostics.mjs replay <session-result.json> [report.json] OR compare <browser-session.json> <sim-ue-0-result.json> [report.json]');
    const read=file=>JSON.parse(fs.readFileSync(file,'utf8'));
    const result=command==='replay'?replaySessionDecisions(read(first)):
      compareDecisionInputs(read(first),read(second));
    const target=command==='replay'?second:output;
    if(target)fs.writeFileSync(target,JSON.stringify(result,null,2)+'\n');
    console.log(JSON.stringify(command==='replay'?{status:result.status,total:result.total,passed:result.passed,
      failures:result.failures.slice(0,5)}:{status:result.status,comparisons:result.comparisons.map(c=>({
        videoId:c.videoId,browserRepresentation:c.browser?.selectedRepresentationId,
        simulationRepresentation:c.simulation?.selectedRepresentationId,
        browserSafeKbps:c.browser?.safeThroughputKbps,
        simulationSafeKbps:c.simulation?.safeThroughputKbps}))},null,2));
    if(command==='replay'&&result.status!=='replay-passed')process.exitCode=1;
  }catch(error){console.error(error.message);process.exitCode=1;}
}
