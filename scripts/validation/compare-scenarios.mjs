import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const finite=n=>typeof n==='number'&&Number.isFinite(n);
const load=filename=>JSON.parse(fs.readFileSync(filename,'utf8'));
const key=r=>[r.resource?.videoId,r.resource?.resourceType,r.resource?.mediaType??'',r.resource?.representationId??'',r.resource?.segmentIndex??''].join('|');
const completed=result=>(result.requests??[]).filter(r=>r.state==='COMPLETED'&&finite(r.startTime)&&finite(r.endTime));
const byKey=items=>{const map=new Map();for(const item of items){const k=key(item);if(!map.has(k))map.set(k,[]);map.get(k).push(item);}return map;};
const mean=items=>items.length?items.reduce((a,b)=>a+b,0)/items.length:null;
const readResult=(directory,ue=0)=>load(path.join(directory,`ue-${ue}-result.json`));
const readNetwork=directory=>load(path.join(directory,'shared-network.json'));
function check(condition,label,detail){return {label,passed:!!condition,detail};}
function compareOrderedTimes(left,right,tolerance,label){
  const pairs=Array.from({length:Math.min(left.length,right.length)},(_,i)=>({expected:left[i],actual:right[i],deltaS:right[i]-left[i]}));
  return {label,expectedCount:left.length,actualCount:right.length,toleranceS:tolerance,pairs,
    passed:left.length===right.length&&pairs.every(p=>finite(p.deltaS)&&Math.abs(p.deltaS)<=tolerance)};
}
function eventTimes(result,type){return (result.events??[]).filter(e=>e.eventType===type).map(e=>e.time);}
function networkTimes(network){return (network?.events??[]).filter(e=>e.eventType==='NETWORK_CAPACITY_CHANGED').map(e=>e.time);}
/** Use the shared session-metrics representation, not browser-specific `waiting` heuristics. */
export function stallDiagnostics(result, scenario) {
  const start = result.sessionRecord?.session_timing?.session_started_at_s ?? 0;
  const expected = scenario.stallValidation;
  const rows = result.sessionRecord?.playback_metrics?.stall_events ?? [];
  const events = result.events ?? [];
  const started = events.filter(e => e.eventType === 'PLAYBACK_STARTED');
  const all = rows.map(row => ({
    videoId: row.video_id,
    startS: row.started_at_s - start,
    endS: finite(row.ended_at_s) ? row.ended_at_s - start : null,
    durationS: row.duration_s,
    status: row.status,
    afterPlaybackStarted: started.some(e => e.videoId === row.video_id &&
      finite(e.time) && e.time < row.started_at_s),
    observedStart: events.some(e => e.eventType === 'STALL_STARTED' &&
      e.videoId === row.video_id && finite(e.time) && Math.abs(e.time-row.started_at_s) < 0.1),
    observedRecovery: events.some(e => e.eventType === 'STALL_RECOVERED' &&
      e.videoId === row.video_id && finite(e.time) && finite(row.ended_at_s) &&
      Math.abs(e.time-row.ended_at_s) < 0.1),
  }));
  const recovered = all.filter(row => row.status === 'recovered' && finite(row.durationS) &&
    finite(row.endS) && row.endS > row.startS && row.afterPlaybackStarted &&
    row.observedStart && row.observedRecovery);
  return {all, recovered, minRecoveredStalls: expected?.minRecoveredStalls ?? null,
    expectedStallVideoIds: expected?.expectedStallVideoIds ?? [],
    meetsRequiredStalls: !expected || (recovered.length >= expected.minRecoveredStalls &&
      expected.expectedStallVideoIds.every(videoId => recovered.some(row =>
        row.videoId === videoId && row.durationS >= expected.minStallDurationS)))};
}
function normalizedBrowserNetwork(browser){
  const events=browser.compactEventLog?.events??[];
  return events.filter(e=>e.eventType==='NETWORK_CAPACITY_CHANGED'&&finite(e.timestampS)).map(e=>e.timestampS);
}
function resources(left,right){
  const a=byKey(completed(left)),b=byKey(completed(right)),pairs=[],unmatched=[];
  for(const [k,requests] of a){const other=b.get(k)??[];
    requests.forEach((r,index)=>{
      if(!other[index]){unmatched.push({key:k,side:'first',index});return;}
      const candidate=other[index];pairs.push({key:k,index,firstStartS:r.startTime,secondStartS:candidate.startTime,
        firstDurationS:r.endTime-r.startTime,secondDurationS:candidate.endTime-candidate.startTime,
        ratio:(candidate.endTime-candidate.startTime)/(r.endTime-r.startTime),
        firstBytes:r.bytesTotal??r.resource?.bytes,secondBytes:candidate.bytesTotal??candidate.resource?.bytes});
    });
  }
  for(const [k,requests] of b)if(requests.length>(a.get(k)?.length??0))unmatched.push({key:k,side:'second',count:requests.length-(a.get(k)?.length??0)});
  return {pairs,unmatched};
}
/** B2 diagnostics distinguish prefetched data from actual use after a swipe. */
export function prefetchDiagnostics(result, scenario) {
  const start = result.sessionRecord?.session_timing?.session_started_at_s ?? 0;
  const firstSwipe = (result.events ?? []).find(e => e.eventType === 'SWIPE')?.time ??
    (start + scenario.swipeTimesS[0]);
  const initialVideo = scenario.playlist[0];
  const future = new Set(scenario.playlist.slice(1));
  const earlyRequests = (result.requests ?? []).filter(r =>
    r.resource?.resourceType === 'media' && future.has(r.resource.videoId) &&
    finite(r.startTime) && r.startTime < firstSwipe);
  const completedBeforeSwipe = earlyRequests.filter(r =>
    r.state === 'COMPLETED' && finite(r.endTime) && r.endTime <= firstSwipe);
  const logical = r => `${r.resource.videoId}|${r.resource.segmentIndex}`;
  const unique = new Set(earlyRequests.map(logical));
  const complete = new Set(completedBeforeSwipe.map(logical));
  const counts = Object.fromEntries([...future].map(video => [video,
    new Set(earlyRequests.filter(r => r.resource.videoId === video).map(logical)).size]));
  const limits = scenario.abr.config;
  const mps = limits.max_preload_segments ?? limits.maxPreloadSegments ?? 6;
  const pspv = limits.preload_segments_per_video ?? limits.preloadSegmentsPerVideo ?? 2;
  const reused = [];
  for (const videoId of future) {
    const swipe = (result.events ?? []).find(e => e.eventType === 'SWIPE' && e.toVideoId === videoId);
    if (!swipe) continue;
    const appended = (result.events ?? []).filter(e =>
      e.eventType === 'RESOURCE_APPENDED' && e.videoId === videoId &&
      finite(e.segmentIndex) && e.time >= swipe.time - 1e-8);
    for (const event of appended) {
      const entry = `${videoId}|${event.segmentIndex}`;
      if (!complete.has(entry)) continue;
      const redownloaded = (result.requests ?? []).some(r =>
        r.resource?.resourceType === 'media' && logical(r) === entry &&
        finite(r.startTime) && r.startTime >= swipe.time - 1e-8 &&
        r.startTime <= event.time + 1e-8);
      reused.push({ videoId, segmentIndex: event.segmentIndex, swipeTimeS: swipe.time,
        appendTimeS: event.time, redownloaded });
    }
  }
  return { initialVideo, firstSwipeTimeS: firstSwipe,
    futureMediaRequestedBeforeFirstSwipe: [...unique].sort(),
    futureMediaCompletedBeforeFirstSwipe: [...complete].sort(),
    perFutureVideoCount: counts, maxPreloadSegments: mps, preloadSegmentsPerVideo: pspv,
    withinInitialPrefetchBudgets: unique.size <= mps && Object.values(counts).every(n => n <= pspv),
    reusedAfterSwipe: reused };
}

/** The browser and simulator share input and schema, not an exact low-level event trace. */
export function compareBrowserSimulation(browser,sim,network,scenario){
  if(!browser||!sim||!scenario)throw new TypeError('Browser, simulation and scenario are required');
  const checks=[],userTol=scenario.comparison?.userEventToleranceS??0.5;
  const starts=(browser.events??[]).filter(e=>e.eventType==='SESSION_STARTED');
  const browserSwipes=(browser.events??[]).filter(e=>e.eventType==='SWIPE').map(e=>e.time);
  const simStart=sim.sessionRecord?.session_timing?.session_started_at_s??0;
  const simSwipes=eventTimes(sim,'SWIPE').map(t=>t-simStart);
  checks.push(check(starts.length===1,'Browser session started once',{count:starts.length}));
  checks.push(compareOrderedTimes(scenario.swipeTimesS,browserSwipes,userTol,'Browser swipe schedule'));
  checks.push(compareOrderedTimes(scenario.swipeTimesS,simSwipes,1e-6,'Simulation swipe schedule'));
  const capExpected=scenario.capacityTrace.slice(1).filter(([time])=>time<=scenario.sessionDurationS).map(([time])=>time);
  const actualBrowserCapacity=normalizedBrowserNetwork(browser);
  const actualSimCapacity=networkTimes(network).map(t=>t-simStart);
  const browserClock=browser.browserExperiment?.clockSynchronization??null;
  const browserCapacity=compareOrderedTimes(capExpected,actualBrowserCapacity,scenario.comparison?.networkEventToleranceS??0.9,
    'Browser capacity event times (synchronized server / browser monotonic clocks)');
  // If browser logging missed a poll, do not misreport a scientific failure as network failure.
  checks.push(browserCapacity);
  checks.push(compareOrderedTimes(capExpected,actualSimCapacity,1e-6,'Simulation capacity event times'));
  const binit=browser.sessionRecord?.session_summary?.initial_playback_delay_s,
    sinit=sim.sessionRecord?.session_summary?.initial_playback_delay_s;
  const startup={browserS:binit??null,simulationS:sinit??null,
    differenceS:finite(binit)&&finite(sinit)?binit-sinit:null,
    withinTolerance:finite(binit)&&finite(sinit)?Math.abs(binit-sinit)<=
      (scenario.comparison?.startupToleranceS??2):null,
    note:'playing event and simulated playback start are not guaranteed first displayed frames'};
  const paired=resources(sim,browser);
  const requestComparison=paired.pairs.map(p=>({...p,startDifferenceS:p.secondStartS-p.firstStartS,
    durationDifferenceS:p.secondDurationS-p.firstDurationS,
    withinRequestTolerance:Math.abs(p.secondStartS-p.firstStartS)<=
      (scenario.comparison?.requestEventToleranceS??1.5)&&Math.abs(p.secondDurationS-p.firstDurationS)<=
      (scenario.comparison?.requestEventToleranceS??1.5)}));
  checks.push(check(requestComparison.length>0&&paired.unmatched.length===0,
    'Completed request resources match (video/type/representation/segment/occurrence)',
    {matched:requestComparison.length,unmatched:paired.unmatched}));
  checks.push(check(requestComparison.length>0&&requestComparison.every(p=>p.withinRequestTolerance),
    'Matched request start times and durations within exploratory tolerance',
    {matched:requestComparison.length,outsideTolerance:requestComparison.filter(p=>!p.withinRequestTolerance).length}));
  checks.push(check(startup.withinTolerance===true,'Initial playback delays within exploratory tolerance',startup));
  const browserPlaying=(browser.events??[]).filter(e=>e.eventType==='PLAYBACK_STARTED');
  const simPlaying=eventTimes(sim,'PLAYBACK_STARTED');
  checks.push(check(browserPlaying.length>0&&browserPlaying.length===simPlaying.length,
    'Playback-start event counts match', {browser:browserPlaying.length,simulation:simPlaying.length}));
  checks.push(compareOrderedTimes(simPlaying.map(t=>t-simStart),browserPlaying.map(e=>e.time),
    scenario.comparison?.startupToleranceS??2,'Per-video playback-start event times'));
  const browserStalls=(browser.events??[]).filter(e=>e.eventType==='STALL_STARTED').map(e=>e.time);
  const simStalls=eventTimes(sim,'STALL_STARTED').map(t=>t-simStart);
  // A stall is an outcome of distinct MSE/virtual-time mechanisms; report instead of requiring identical stall counts.
  const stallComparison={browserCount:browserStalls.length,simulationCount:simStalls.length,
    alignedIfSameCount:browserStalls.length===simStalls.length
      ?compareOrderedTimes(simStalls,browserStalls,scenario.comparison?.startupToleranceS??2,'Stall-start event times')
      :null};
  if (scenario.stallValidation) {
    const b = stallDiagnostics(browser, scenario);
    const v = stallDiagnostics(sim, scenario);
    const expectedVideos = scenario.stallValidation.expectedStallVideoIds;
    const startTolerance = scenario.comparison?.stallStartToleranceS ?? 2.5;
    const durationTolerance = scenario.comparison?.stallDurationToleranceS ?? 2.5;
    const pairs = expectedVideos.map(videoId => {
      const bs = b.recovered.find(row => row.videoId === videoId);
      const vs = v.recovered.find(row => row.videoId === videoId);
      return {videoId, browser:bs ?? null, simulation:vs ?? null,
        startDifferenceS: bs && vs ? bs.startS - vs.startS : null,
        endDifferenceS: bs && vs ? bs.endS - vs.endS : null,
        durationDifferenceS: bs && vs ? bs.durationS - vs.durationS : null};
    });
    const aligned = pairs.every(pair => pair.browser && pair.simulation &&
      Math.abs(pair.startDifferenceS) <= startTolerance &&
      Math.abs(pair.endDifferenceS) <= startTolerance &&
      Math.abs(pair.durationDifferenceS) <= durationTolerance);
    checks.push(check(b.meetsRequiredStalls && v.meetsRequiredStalls,
      'B1/B2 forced stalling: both runtimes show genuine recovered stalls after playback starts',
      {browser:b, simulation:v}));
    checks.push(check(aligned,
      'B1/B2 forced stalling: per-video start, recovery and duration are within exploratory tolerance',
      {pairs, startToleranceS:startTolerance, durationToleranceS:durationTolerance}));
    stallComparison.forcedStallValidation = {browser:b, simulation:v, pairs};
  }
  let prefetchComparison = null;
  if (scenario.abr.name === 'prefetch') {
    const b = prefetchDiagnostics(browser, scenario);
    const v = prefetchDiagnostics(sim, scenario);
    const sameLogicalPrefetch = JSON.stringify(b.futureMediaCompletedBeforeFirstSwipe) ===
      JSON.stringify(v.futureMediaCompletedBeforeFirstSwipe);
    const browserReuse = b.reusedAfterSwipe.filter(x => !x.redownloaded);
    const simulatedReuse = v.reusedAfterSwipe.filter(x => !x.redownloaded);
    checks.push(check(b.withinInitialPrefetchBudgets && v.withinInitialPrefetchBudgets,
      'B2 initial prefetch respects MPS and PSPV in both runtimes', {browser:b,simulation:v}));
    checks.push(check(b.futureMediaCompletedBeforeFirstSwipe.length > 0 && sameLogicalPrefetch,
      'B2 pre-swiped completed future media match by logical video/segment',
      {browser:b.futureMediaCompletedBeforeFirstSwipe,simulation:v.futureMediaCompletedBeforeFirstSwipe}));
    checks.push(check(browserReuse.length > 0 && simulatedReuse.length > 0 &&
      b.reusedAfterSwipe.every(x => !x.redownloaded) && v.reusedAfterSwipe.every(x => !x.redownloaded),
      'B2 preloaded media is appended after swipe without redundant download',
      {browser:b.reusedAfterSwipe,simulation:v.reusedAfterSwipe}));
    prefetchComparison = {browser:b,simulation:v};
  }
  const config=browser.browserExperiment?.profile?.configuration;
  checks.push(check(config?.abr?.name===scenario.abr.name&&JSON.stringify(config?.playlist?.map(p=>p.videoId))===JSON.stringify(scenario.playlist),
    'Browser used the expected ABR and playlist',config?{abr:config.abr.name,playlist:config.playlist.map(p=>p.videoId)}:null));
  return {schemaVersion:1,scenarioId:scenario.scenarioId,abr:scenario.abr.name,
    comparison:'browser-vs-simulation',status:checks.every(c=>c.passed)?'timing-checks-passed':'review-required',
    note:'This is an observational comparison, NOT proof of full browser–simulator parity. Missing or unmatched events are reported, not guessed.',
    checks,startup,stallComparison,prefetchComparison,clockSynchronization:browserClock?{
      method:browserClock.method,serverInstanceId:browserClock.serverInstanceId,
      roundTripS:browserClock.roundTripS,exchangeErrorBoundS:browserClock.exchangeErrorBoundS,
      sampleCount:browserClock.sampleCount}:null,
    matchedRequests:requestComparison,unmatchedRequests:paired.unmatched,
    requestMatchesWithinTolerance:requestComparison.filter(p=>p.withinRequestTolerance).length,
    browserRequestCount:browser.requests?.length??null,simulationRequestCount:sim.requests?.length??null};
}
export function compareOneTwo(one,two0,two1,oneNetwork,twoNetwork,scenario){
  const checks=[],baseStart=one.sessionRecord.session_timing.session_started_at_s;
  checks.push(compareOrderedTimes(eventTimes(one,'SWIPE').map(t=>t-baseStart),eventTimes(two0,'SWIPE'),1e-7,'One UE versus two-UE #0 swipe schedule'));
  checks.push(compareOrderedTimes(eventTimes(two0,'SWIPE'),eventTimes(two1,'SWIPE'),1e-7,'Two-UE symmetrical swipe schedules'));
  checks.push(compareOrderedTimes(networkTimes(oneNetwork),networkTimes(twoNetwork),1e-7,'Same capacity-change times'));
  const a=resources(one,two0),b=resources(two0,two1);
  checks.push(check(b.unmatched.length===0&&b.pairs.every(p=>Math.abs(p.firstDurationS-p.secondDurationS)<1e-7),
    'Identical UEs have identical completed request durations',
    {matched:b.pairs.length,unmatched:b.unmatched}));
  let stallComparison = null;
  if (scenario.stallValidation) {
    const diagnostics = [one,two0,two1].map(result => stallDiagnostics(result,scenario));
    const twin0 = diagnostics[1].recovered;
    const twin1 = diagnostics[2].recovered;
    checks.push(check(diagnostics.every(d => d.meetsRequiredStalls),
      'B1/B2 forced stalling: solo and both concurrent UEs show post-start stalls and recovery',
      diagnostics));
    checks.push(check(twin0.length === twin1.length && twin0.every((event,index) => {
      const other = twin1[index];
      return other && event.videoId === other.videoId &&
        Math.abs(event.startS-other.startS) < 1e-7 &&
        Math.abs(event.endS-other.endS) < 1e-7;
    }), 'Identical concurrent UEs have symmetric stall start and recovery times',
    {twoUE0:twin0,twoUE1:twin1}));
    stallComparison = {one:diagnostics[0],twoUE0:diagnostics[1],twoUE1:diagnostics[2]};
  }
  let prefetchComparison = null;
  if (scenario.abr.name === 'prefetch') {
    const diagnostics = [one, two0, two1].map(result => prefetchDiagnostics(result,scenario));
    checks.push(check(diagnostics.every(d => d.withinInitialPrefetchBudgets &&
      d.futureMediaCompletedBeforeFirstSwipe.length > 0),
      'B2 all UEs prefetch future media within MPS/PSPV before first swipe', diagnostics));
    checks.push(check(diagnostics.every(d => d.reusedAfterSwipe.length > 0 &&
      d.reusedAfterSwipe.every(r => !r.redownloaded)),
      'B2 prefetched media are reused after swipes in every UE', diagnostics.map(d => d.reusedAfterSwipe)));
    prefetchComparison = {one:diagnostics[0],twoUE0:diagnostics[1],twoUE1:diagnostics[2]};
  }
  const media=a.pairs.filter(p=>p.key.includes('|media|'));
  const early=media.filter(p=>p.firstStartS<scenario.capacityTrace[1][0]&&p.firstStartS+p.secondDurationS<scenario.capacityTrace[1][0]);
  return {schemaVersion:1,scenarioId:scenario.scenarioId,abr:scenario.abr.name,
    comparison:'one-vs-two-UE',status:checks.every(c=>c.passed)?'invariants-passed':'review-required',
    note:'No universal 2x guarantee: fixed RTT, queueing, ABR changes and capacity transitions affect total duration.',
    checks,prefetchComparison,stallComparison,matchedRequests:a.pairs,unmatchedRequests:a.unmatched,
    mediaRatios:media.map(p=>({resource:p.key,ratio:p.ratio,oneDurationS:p.firstDurationS,twoDurationS:p.secondDurationS,
      firstStartS:p.firstStartS})),
    earlyPreCapacityChangeMediaRatios:early.map(p=>({resource:p.key,ratio:p.ratio})),
    meanMediaRatio:mean(media.map(p=>p.ratio)),
    noteOnLatency:'For otherwise identical simultaneous isolated transfers at constant capacity, payload transmission time is 2x, but total request time with fixed latency L is L+2T versus L+T.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [mode,arg1,arg2,arg3,arg4]=process.argv.slice(2);
  const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
  const scenario=load(arg4?path.resolve(arg4):path.join(project,'scenarios/validation/scenario-b1-v1.json'));
  try{
    let result,destination;
    if(mode==='browser'){
      if(!arg1||!arg2||!arg3)throw new Error('Usage: browser <browser-session.json> <sim-one-directory> <report.json>');
      result=compareBrowserSimulation(load(arg1),readResult(arg2),readNetwork(arg2),scenario);destination=arg3;
    }else if(mode==='one-vs-two'){
      if(!arg1||!arg2||!arg3)throw new Error('Usage: one-vs-two <sim-one-directory> <sim-two-directory> <report.json>');
      result=compareOneTwo(readResult(arg1),readResult(arg2,0),readResult(arg2,1),readNetwork(arg1),readNetwork(arg2),scenario);
      destination=arg3;
    }else throw new Error('Mode must be browser or one-vs-two');
    fs.mkdirSync(path.dirname(path.resolve(destination)),{recursive:true});
    fs.writeFileSync(destination,JSON.stringify(result,null,2)+'\n');
    console.log(`${result.comparison}: ${result.status}; ${result.checks.filter(c=>c.passed).length}/${result.checks.length} checks passed; report: ${destination}`);
    if(result.status==='review-required')process.exitCode=1;
  }catch(error){console.error(error.stack??String(error));process.exitCode=2;}
}
