import {resolveCapacityGenerator, resolveUserInteractions} from '../simulation/generators/SFVGenerators.js';
import {SFVBrowserUserAutomation} from './SFVBrowserUserAutomation.js';

export const BROWSER_EXPERIMENT_SCHEMA_VERSION = 1;

const isObject=value=>value!==null && typeof value==='object' && !Array.isArray(value);
function object(value,name){if(!isObject(value))throw new TypeError(`${name} must be an object`);return value;}
function keys(value,allowed,name){for(const key of Object.keys(value)){if(!allowed.includes(key))throw new TypeError(`${name}.${key} is not supported`);}}
function finiteNumber(value,name,{min=0,integer=false}={}){
  if(typeof value!=='number'||!Number.isFinite(value)||value<min||(integer&&!Number.isSafeInteger(value))){
    throw new TypeError(`${name} must be a ${integer?'safe integer':'finite number'} >= ${min}`);
  }
  return value;
}
function validatedCapacityTrace(trace){
  if(!Array.isArray(trace)||!trace.length||trace.some((entry,i)=>!Array.isArray(entry)||entry.length!==2||
    !Number.isFinite(entry[0])||entry[0]<0||!Number.isFinite(entry[1])||entry[1]<0||
    (i===0&&entry[0]!==0)||(i>0&&entry[0]<=trace[i-1][0]))){
    throw new TypeError('network.capacityTrace must start at time 0 and contain increasing [timeS, capacityMbps] pairs');
  }
}

/** Validate a browser-only experiment BEFORE changing an existing session or network profile.
 * This interface accepts browser experiment configurations, not simulator-only inputs.
 */
export function validateBrowserExperimentConfig(value){
  const input=object(value,'experiment');
  keys(input,['schemaVersion','experimentId','abr','playlist','network','userModel','cache','scheduling','requestRetry','seed','diagnostics'], 'experiment');
  if(input.schemaVersion!==BROWSER_EXPERIMENT_SCHEMA_VERSION)throw new TypeError('experiment.schemaVersion must be 1');
  if(typeof input.experimentId!=='string'||!input.experimentId.trim())throw new TypeError('experiment.experimentId must be a nonempty string');
  const abr=object(input.abr,'abr');keys(abr,['name','config'],'abr');
  if(!['current','prefetch'].includes(abr.name))throw new TypeError('abr.name must be "current" or "prefetch"');
  const rule=object(abr.config??{},'abr.config');
  keys(rule,['max_preload_segments','preload_segments_per_video','activeBufferTargetSegments'],'abr.config');
  const abrConfig={activeBufferTargetSegments:2,max_preload_segments:4,preload_segments_per_video:2,...rule};
  for(const key of Object.keys(abrConfig))finiteNumber(abrConfig[key],`abr.config.${key}`,{integer:true,min:key==='activeBufferTargetSegments'?1:0});
  if(!Array.isArray(input.playlist)||!input.playlist.length)throw new TypeError('playlist must be a nonempty array');
  const seen=new Set();
  const playlist=input.playlist.map((entry,index)=>{
    const item=typeof entry==='string'?{videoId:entry}:object(entry,`playlist[${index}]`);
    keys(item,['videoId','manifestUrl'],`playlist[${index}]`);
    if(typeof item.videoId!=='string'||!(/^[A-Za-z0-9_-]+$/).test(item.videoId))throw new TypeError(`playlist[${index}].videoId must contain only letters, digits, _ or -`);
    if(seen.has(item.videoId))throw new TypeError(`Duplicate videoId in playlist: ${item.videoId}`);
    seen.add(item.videoId);
    if(item.manifestUrl!==undefined){
      if(typeof item.manifestUrl!=='string'||!item.manifestUrl.trim())throw new TypeError(`playlist[${index}].manifestUrl must be a nonempty URL`);
      let url;
      try{url=new URL(item.manifestUrl,'http://localhost/');}catch{throw new TypeError(`playlist[${index}].manifestUrl is not a valid URL`);}
      if(!['http:','https:'].includes(url.protocol))throw new TypeError(`playlist[${index}].manifestUrl must use HTTP(S)`);
    }
    return {...item};
  });
  const seed=input.seed??1;finiteNumber(seed,'seed',{integer:true});
  let network=null;
  if(input.network!==undefined && input.network!==null){
    const n=object(input.network,'network');
    keys(n,['enabled','capacityMbps','capacityTrace','capacityGenerator','latencyMs','faults'],'network');
    if(n.enabled!==undefined&&typeof n.enabled!=='boolean')throw new TypeError('network.enabled must be boolean');
    if(n.capacityGenerator!==undefined&&(n.capacityTrace!==undefined||n.capacityMbps!==undefined)){
      throw new TypeError('Use network.capacityGenerator OR capacityTrace/capacityMbps');
    }
    if(n.capacityTrace!==undefined&&n.capacityMbps!==undefined)throw new TypeError('Use network.capacityTrace OR capacityMbps');
    if(n.capacityMbps!==undefined)finiteNumber(n.capacityMbps,'network.capacityMbps');
    if(n.capacityTrace!==undefined)validatedCapacityTrace(n.capacityTrace);
    if(n.latencyMs!==undefined)finiteNumber(n.latencyMs,'network.latencyMs');
    if(n.faults!==undefined){
      if(!Array.isArray(n.faults))throw new TypeError('network.faults must be an array');
      for(const [i,f] of n.faults.entries()){
        object(f,`network.faults[${i}]`);keys(f,['pathIncludes','status','truncateAfterBytes','occurrence'],`network.faults[${i}]`);
        if(typeof f.pathIncludes!=='string')throw new TypeError(`network.faults[${i}].pathIncludes must be a string`);
        if(f.status!==undefined)finiteNumber(f.status,`network.faults[${i}].status`,{integer:true,min:400});
        if(f.status!==undefined&&f.status>599)throw new TypeError('HTTP fault status must be <= 599');
        if(f.truncateAfterBytes!==undefined)finiteNumber(f.truncateAfterBytes,`network.faults[${i}].truncateAfterBytes`,{integer:true});
        if(f.occurrence!==undefined)finiteNumber(f.occurrence,`network.faults[${i}].occurrence`,{integer:true,min:1});
      }
    }
    if(n.capacityGenerator!==undefined){
      object(n.capacityGenerator,'network.capacityGenerator');
      validatedCapacityTrace(resolveCapacityGenerator(n.capacityGenerator).trace);
    }
    network=structuredClone(n);
  }
  const cache=object(input.cache??{},'cache');keys(cache,['maxBytes'],'cache');
  const maxBytes=cache.maxBytes??null;
  if(maxBytes!==null)finiteNumber(maxBytes,'cache.maxBytes',{integer:true});
  const scheduling=object(input.scheduling??{},'scheduling');
  keys(scheduling,['maxConcurrentRequests','swipeCancellation','requestProgress'],'scheduling');
  const maxConcurrentRequests=scheduling.maxConcurrentRequests??0;
  finiteNumber(maxConcurrentRequests,'scheduling.maxConcurrentRequests',{integer:true});
  if(scheduling.swipeCancellation!==undefined&&typeof scheduling.swipeCancellation!=='boolean')throw new TypeError('scheduling.swipeCancellation must be boolean');
  if(scheduling.requestProgress!==undefined&&typeof scheduling.requestProgress!=='boolean')throw new TypeError('scheduling.requestProgress must be boolean');
  const requestRetry=object(input.requestRetry??{},'requestRetry');keys(requestRetry,['maxRetries','delayMs'],'requestRetry');
  const maxRetries=requestRetry.maxRetries??0,delayMs=requestRetry.delayMs??250;
  finiteNumber(maxRetries,'requestRetry.maxRetries',{integer:true});finiteNumber(delayMs,'requestRetry.delayMs');
  let userModel=null;
  if(input.userModel!==undefined&&input.userModel!==null){
    const model=object(input.userModel,'userModel');
    keys(model,['type','seed','swipeTimesS','watchDurationRangeS','sessionStartDelayS','sessionStartWindowS','sessionDurationS'],'userModel');
    if(!['sequence','seeded'].includes(model.type))throw new TypeError('userModel.type must be "sequence" or "seeded"');
    if(model.seed!==undefined)finiteNumber(model.seed,'userModel.seed',{integer:true});
    if(model.sessionDurationS!==undefined)finiteNumber(model.sessionDurationS,'userModel.sessionDurationS');
    if(model.sessionStartDelayS!==undefined&&model.sessionStartWindowS!==undefined)throw new TypeError('Use userModel.sessionStartDelayS OR sessionStartWindowS');
    SFVBrowserUserAutomation.resolveStartDelay(model,seed);
    resolveUserInteractions(model,{seed,maxSwipes:Math.max(0,playlist.length-1),horizonS:model.sessionDurationS??Infinity});
    userModel=structuredClone(model);
  }
  const diagnostics=object(input.diagnostics??{},'diagnostics');keys(diagnostics,['abrDecisions'],'diagnostics');
  if(diagnostics.abrDecisions!==undefined&&typeof diagnostics.abrDecisions!=='boolean')throw new TypeError('diagnostics.abrDecisions must be boolean');
  return {schemaVersion:1,experimentId:input.experimentId,seed,abr:{name:abr.name,config:abrConfig},
    playlist,network,userModel,cache:{maxBytes},scheduling:{maxConcurrentRequests,
      swipeCancellation:scheduling.swipeCancellation??true,requestProgress:scheduling.requestProgress??false},
    requestRetry:{maxRetries,delayMs},diagnostics:{abrDecisions:diagnostics.abrDecisions??false}};
}

export function parseBrowserExperimentConfig(json){
  let value;
  try{value=JSON.parse(json);}catch(error){throw new SyntaxError(`Invalid experiment JSON: ${error.message}`);}
  return validateBrowserExperimentConfig(value);
}

export function resolveBrowserNetworkProfile(config){
  const network=config.network;
  if(!network||network.enabled===false)return null;
  if(!network.capacityGenerator)return structuredClone(network);
  const resolved={...network,capacityTrace:resolveCapacityGenerator(network.capacityGenerator).trace};
  delete resolved.capacityGenerator;
  return resolved;
}
