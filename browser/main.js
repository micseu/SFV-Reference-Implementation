import {SFVBrowserController} from '/src/dashjs/SFVBrowserController.js';
import {SFVCurrentVideoRule} from '/src/rules/SFVCurrentVideoRule.js';
import {SFVMultiVideoPrefetchRule} from '/src/rules/SFVMultiVideoPrefetchRule.js';
import {SFVBrowserUserAutomation} from '/src/browser/SFVBrowserUserAutomation.js';
import {validateBrowserExperimentConfig,parseBrowserExperimentConfig,
  resolveBrowserNetworkProfile} from '/src/browser/SFVBrowserExperimentConfig.js';
import {buildCompactEventLog,formatCompactEventLog,filterCompactEventLog} from '/src/output/SFVCompactEventLog.js';
import {SFVBrowserServerClock} from '/src/browser/SFVBrowserServerClock.js';
import {clearSFVMediaCache} from '/src/browser/SFVBrowserCacheIsolation.js';

// Page lifetime identity distinguishes consecutive sessions in the same loaded UI.
const pageInstanceId=crypto.randomUUID();
const $=id=>document.getElementById(id);
let controller=null,automation=null,lastResult=null,lastAutomationSnapshot=null,experimentProfile=null;
let pendingSessionStartTimer=null;
let eventLogTimer=null,lastNetworkSnapshot=null,lastCompactText='';
let clock=new SFVBrowserServerClock(),lastClockProbeS=-Infinity,clockProbeInFlight=null;
let launchInProgress=false,selection='entry',lastCacheIsolation=null;
const dashjs=window.dashjs;
if(!dashjs?.MediaPlayer)throw new Error('Patched dash.js bundle not loaded');
const parserPlayer=dashjs.MediaPlayer().create();
parserPlayer.updateSettings({streaming:{scheduling:{externallyControlled:true}}});
const parseDashManifest=xml=>parserPlayer.parseSFVManifest(xml);
function showScreen(name){
  selection=name;
  for(const screen of ['entry','json','workspace'])$(`${screen}-screen`).hidden=screen!==name;
  if(name==='workspace')$('workspace-screen').scrollIntoView({block:'start'});
}
function report(message){
  $('status').textContent=String(message);
  $('log').textContent+=String(message)+'\n';
  if(selection==='json')$('setup-message').textContent=String(message);
}
function updateClockStatus(){
  const sync=clock.snapshot();
  $('clock-summary').textContent=sync.sampleCount?`Server clock aligned (±${(sync.exchangeErrorBoundS*1000).toFixed(1)} ms RTT bound)`:'Server clock: not synchronized';
  $('clock-status').textContent=sync.sampleCount
    ?`Server − browser monotonic clock: ${sync.offsetServerMinusClientS.toFixed(6)} s; `+
      `RTT ${(sync.roundTripS*1000).toFixed(1)} ms; midpoint uncertainty up to ±${(sync.exchangeErrorBoundS*1000).toFixed(1)} ms; `+
      `${sync.sampleCount} samples. Timing of browser/MSE events has additional uncertainty.`
    :'Server clock not synchronized yet. Network timestamps cannot be aligned.';
}
async function synchronizeClock({samples=3,force=false}={}){
  if(clockProbeInFlight)return clockProbeInFlight;
  if(!force&&performance.now()/1000-lastClockProbeS<10)return clock.snapshot();
  const targetClock=clock;
  const pending=targetClock.synchronize({samples}).then(snapshot=>{
    if(targetClock===clock){lastClockProbeS=performance.now()/1000;updateClockStatus();}
    return snapshot;
  }).finally(()=>{if(clockProbeInFlight===pending)clockProbeInFlight=null;});
  clockProbeInFlight=pending;
  return clockProbeInFlight;
}
function stopEventLogRefresh(){if(eventLogTimer!==null){clearInterval(eventLogTimer);eventLogTimer=null;}}
function alignedNetworkEvents(snapshot){
  return clock.alignEmulatorEvents(snapshot,{sessionEpochClientS:controller?.started?controller.epochStart:null});
}
function compactLog(result){
  return buildCompactEventLog({events:result.events,sessionRecord:result.sessionRecord,
    networkEvents:alignedNetworkEvents(lastNetworkSnapshot).filter(e=>e.time<=result.timeS+1e-6),
    clockOrigin:'session_start'});
}
function renderCompactLog(result){
  if(!result)return;
  const fullLog=compactLog(result);
  lastCompactText=formatCompactEventLog(fullLog);
  const enabled=[...document.querySelectorAll('#event-source-filters input:checked')].map(input=>input.value);
  const formatted=formatCompactEventLog(filterCompactEventLog(fullLog,enabled));
  const lines=formatted.split('\n');
  const visible=lines.slice(-350);
  const panel=$('event-log');
  const nearBottom=panel.scrollTop+panel.clientHeight>=panel.scrollHeight-35;
  panel.textContent=(lines.length>visible.length?`Showing last ${visible.length} of ${lines.length} events. Copy Short Log includes all sources.\n`:'')+
    (formatted?visible.join('\n'):(lastCompactText?'No events for the selected sources.':'No events yet.'));
  if(nearBottom)panel.scrollTop=panel.scrollHeight;
  $('copy-event-log').disabled=!lastCompactText;
}
async function refreshEventLog(){
  if(!controller?.started&&!lastResult)return;
  const active=controller;
  try{
    // Periodically refresh the clock relationship without ever adjusting ABR/session time.
    await synchronizeClock({samples:2});
  }catch(error){$('clock-status').textContent=`Clock synchronization unavailable: ${error.message}`;}
  try{
    const response=await fetch('/__sfv/emulation',{cache:'no-store'});
    if(response.ok){
      const snapshot=await response.json();
      if(active!==controller)return;
      lastNetworkSnapshot=snapshot.profile?snapshot:null;
    }
  }catch{ /* Raw SFV events remain available if the server diagnostics fail. */ }
  if(active!==controller)return;
  try{renderCompactLog(lastResult??active.result('simulation_cutoff',{samplePlayback:false}));}
  catch(error){console.error('Could not render the diagnostic event log',error);}
}
function startEventLogRefresh(){
  stopEventLogRefresh();
  eventLogTimer=setInterval(()=>{void refreshEventLog();},1000);
  void refreshEventLog();
}
function readProfile(id){const value=$(id).value.trim();return value?JSON.parse(value):null;}
function readManualConfiguration(){
  return validateBrowserExperimentConfig({
    schemaVersion:1,experimentId:'browser-manual',seed:1,
    abr:{name:$('rule').value==='b1'?'current':'prefetch',config:{
      max_preload_segments:Number($('mps').value),
      preload_segments_per_video:Number($('pspv').value),activeBufferTargetSegments:2}},
    playlist:['v1','v2','v3'],userModel:readProfile('userprofile'),network:readProfile('networkprofile'),
    cache:{maxBytes:$('cachebytes').value.trim()?Number($('cachebytes').value):null},
    scheduling:{swipeCancellation:true,maxConcurrentRequests:Number($('maxrequests').value)},
    diagnostics:{abrDecisions:$('abrdiagnostics').checked},
    requestRetry:{maxRetries:Number($('retries').value),delayMs:250}
  });
}
async function configureNetwork(profile){
  const response=await fetch('/__sfv/emulation',{method:'POST',headers:{'content-type':'application/json'},
    body:JSON.stringify(profile??{enabled:false})});
  const result=await response.json();
  if(!response.ok)throw new Error(result.error??`Network configuration failed: HTTP ${response.status}`);
  return result;
}
async function finish(){
  lastAutomationSnapshot=automation?.snapshot()??lastAutomationSnapshot;automation?.stop();automation=null;
  if(controller&&!controller.stopped){
    $('swipe').disabled=true;$('export').disabled=true;
    lastResult=await controller.stopAndDrain();
    $('export').disabled=false;
    report(`Session ended. Terminal request states settled: ${lastResult.requestTerminationSettled}. Export is available.`);
  }
  stopEventLogRefresh();
  await refreshEventLog();
}
/** Both launch buttons use this exact runtime path. Only the configuration source differs. */
async function startExperiment(config,source){
  // Validation has already completed before this function is entered.
  if(launchInProgress){report('A session is already being prepared.');return;}
  launchInProgress=true;
  $('start').disabled=true;$('start-experiment').disabled=true;
  if(pendingSessionStartTimer!==null){clearTimeout(pendingSessionStartTimer);pendingSessionStartTimer=null;}
  try{
    stopEventLogRefresh();lastNetworkSnapshot=null;lastCompactText='';
    clock=new SFVBrowserServerClock();clockProbeInFlight=null;lastClockProbeS=-Infinity;updateClockStatus();
    $('event-log').textContent='No events yet.';$('copy-event-log').disabled=true;
    if(controller){automation?.stop();automation=null;lastAutomationSnapshot=null;await controller.stopAndDrain();controller=null;$('log').textContent='';}
    $('enable-playback').hidden=true;$('swipe').disabled=true;$('export').disabled=true;
    experimentProfile={source,configuration:structuredClone(config),userModel:config.userModel,
      network:config.network,resolvedNetwork:resolveBrowserNetworkProfile(config)};
    const rule=config.abr.name==='current'?new SFVCurrentVideoRule():new SFVMultiVideoPrefetchRule();
    const playlist=config.playlist.map(item=>({videoId:item.videoId,
      manifestUrl:new URL(item.manifestUrl??`/media/${item.videoId}/manifest-video-only.mpd`,location.href).href}));
    // Stop-and-drain above ensures the old in-memory store and MSE slot are released.
    // CacheStorage entries are removed only for SFV media; the transport bypasses HTTP cache.
    try{lastCacheIsolation=await clearSFVMediaCache({playlist});}
    catch(error){lastCacheIsolation={mode:'http-no-store',cacheStorageAvailable:null,
      deletedEntries:0,error:error.message};report(`CacheStorage cleanup unavailable: ${error.message}; HTTP cache bypass remains enabled.`);}
    report(`Session cache isolation: HTTP cache bypass enabled; removed ${lastCacheIsolation.deletedEntries} SFV CacheStorage entries.`);
    controller=new SFVBrowserController({dashjs,parseDashManifest,videoElement:$('video'),playlist,rule,
      config:{experimentId:config.experimentId,seed:config.seed,
        cache:{maxBytes:config.cache.maxBytes??Infinity},rule:config.abr.config,
        scheduling:{...config.scheduling,maxConcurrentRequests:config.scheduling.maxConcurrentRequests||Infinity},
        requestRetry:config.requestRetry,diagnostics:config.diagnostics},
      onError:error=>report(`ERROR ${error.message}`),
      onAutoplayBlocked:videoId=>{if(controller?.playback.videoId===videoId){
        $('enable-playback').hidden=false;
        report(`Autoplay blocked for ${videoId}. Click Enable Playback to start with a user gesture.`);
      }}});
    lastResult=null;
    const model=config.userModel;
    const startDelayS=SFVBrowserUserAutomation.resolveStartDelay(model,model?.seed??config.seed);
    const runStartS=performance.now()/1000;
    const begin=async()=>{
      pendingSessionStartTimer=null;
      try{
        // The emulation trace begins with session activation, not before a configured start delay.
        try{await synchronizeClock({samples:5,force:true});}
        catch(error){report(`Clock synchronization unavailable: ${error.message}; network event alignment disabled.`);}
        const snapshot=await configureNetwork(experimentProfile.resolvedNetwork);
        lastNetworkSnapshot=snapshot.profile?snapshot:null;
        controller.start();
        $('enable-playback').hidden=true;$('swipe').disabled=false;$('export').disabled=false;
        report(`Session started (${config.experimentId}; ${source}). Fetching and automatic playback enabled.`);
        startEventLogRefresh();
        if(model){
          controller.recordExperimentEvent({action:'SESSION_START',atS:startDelayS,
            actualAtS:performance.now()/1000-runStartS});
          automation=new SFVBrowserUserAutomation({model,playlistLength:playlist.length,
            seed:model.seed??config.seed,sessionDurationS:model.sessionDurationS??null,
            onSwipe:()=>controller.swipeNext(),onEnd:()=>finish().catch(error=>report(`ERROR ${error.message}`)),
            onObservation:e=>controller?.recordExperimentEvent(e)}).start();
          report(`Automated user schedule: ${JSON.stringify(automation.plannedEvents)}`);
        }
      }catch(error){report(`ERROR ${error.message}`);}
      finally{launchInProgress=false;$('start').disabled=false;$('start-experiment').disabled=false;}
    };
    // A validated JSON launch shows only the player and event log after Start Experiment.
    showScreen('workspace');
    if(startDelayS>0){
      report(`Session scheduled after ${startDelayS.toFixed(3)} s.`);
      pendingSessionStartTimer=setTimeout(()=>{void begin();},startDelayS*1000);
    }else await begin();
  }catch(error){report(`ERROR ${error.message}`);
    launchInProgress=false;$('start').disabled=false;$('start-experiment').disabled=false;}
}
$('choose-json').onclick=()=>showScreen('json');
$('choose-manual').onclick=()=>showScreen('workspace');
$('config-back').onclick=()=>showScreen('entry');
$('configure-new').onclick=()=>{
  if(launchInProgress||controller?.started&&!controller?.stopped){
    report('End the current session before configuring a new experiment.');return;
  }
  showScreen('json');
};
$('start').onclick=()=>{
  let config;
  try{config=readManualConfiguration();}catch(error){report(`Invalid manual configuration: ${error.message}`);return;}
  startExperiment(config,'manual-fields');
};
$('start-experiment').onclick=()=>{
  let config;
  try{config=parseBrowserExperimentConfig($('experimentconfig').value);}catch(error){
    report(`Invalid experiment configuration: ${error.message}`);return;
  }
  startExperiment(config,'json-editor');
};
$('example-config').onclick=async()=>{
  try{
    const response=await fetch('/browser/experiment-example.json');
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    const source=await response.text();
    parseBrowserExperimentConfig(source);
    $('experimentconfig').value=source;
    report('Example configuration loaded. Click Start Experiment to use it.');
  }catch(error){report(`Could not load example: ${error.message}`);}
};
$('fields-to-json').onclick=()=>{
  try{$('experimentconfig').value=JSON.stringify(readManualConfiguration(),null,2);
    report('Manual fields copied to the JSON editor. Click Start Experiment to run them.');
  }catch(error){report(`Invalid manual configuration: ${error.message}`);}
};
$('enable-playback').onclick=()=>{
  if(!controller)return;
  controller.play({cause:'autoplay_unblock'}).then(()=>{$('enable-playback').hidden=true;})
    .catch(error=>report(`Playback could not be enabled: ${error.message}`));
};
$('video').addEventListener('playing',()=>{$('enable-playback').hidden=true;});
$('swipe').onclick=()=>controller?.swipeNext().then(ok=>report(ok?'Switched to next video.':'End of feed.'))
  .catch(error=>report(`ERROR ${error.message}`));
$('end').onclick=()=>{
  if(pendingSessionStartTimer!==null){clearTimeout(pendingSessionStartTimer);pendingSessionStartTimer=null;
    controller?.stop();launchInProgress=false;$('start').disabled=false;$('start-experiment').disabled=false;
    report('Scheduled session cancelled before start.');return;}
  finish().catch(error=>report(`ERROR ${error.message}`));
};
document.querySelectorAll('#event-source-filters input').forEach(input=>{
  input.addEventListener('change',()=>{
    const result=lastResult??(controller?.started?controller.result('simulation_cutoff',{samplePlayback:false}):null);
    if(result)renderCompactLog(result);
  });
});
$('copy-event-log').onclick=()=>{
  if(!lastCompactText)return;
  navigator.clipboard.writeText(lastCompactText).then(()=>report('Short event log copied to clipboard.'))
    .catch(error=>report(`Could not copy event log: ${error.message}`));
};
$('export').onclick=async()=>{
  if(!controller&&!lastResult)return;
  await refreshEventLog();
  const result=lastResult??controller.result();
  result.browserExperiment={profile:experimentProfile,userAutomation:automation?.snapshot()??lastAutomationSnapshot,
    cacheIsolation:lastCacheIsolation,pageInstanceId};
  try{const response=await fetch('/__sfv/emulation',{cache:'no-store'});
    if(!response.ok)throw new Error(`HTTP ${response.status}`);
    result.browserExperiment.serverNetwork=await response.json();
    lastNetworkSnapshot=result.browserExperiment.serverNetwork.profile?result.browserExperiment.serverNetwork:null;
  }catch(error){result.browserExperiment.serverNetworkError=error.message;}
  result.browserExperiment.clockSynchronization={...clock.snapshot(),
    sessionEpochClientS:controller?.epochStart??null,sessionStartServerTimeS:clock.best&&controller?.epochStart!==undefined
      ?controller.epochStart+clock.best.offsetS:null};
  result.browserExperiment.alignedServerEvents=alignedNetworkEvents(lastNetworkSnapshot);
  result.compactEventLog=compactLog(result);
  const url=URL.createObjectURL(new Blob([JSON.stringify(result,null,2)],{type:'application/json'}));
  const anchor=document.createElement('a');anchor.href=url;anchor.download='sfv-browser-session.json';anchor.click();
  URL.revokeObjectURL(url);
};
