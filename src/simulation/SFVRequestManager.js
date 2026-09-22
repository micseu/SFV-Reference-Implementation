import {normalizeRetryPolicy} from '../request/SFVRetryPolicy.js';
import { ACTION, REQUEST_STATE } from '../core/constants.js';

/**
 * Per-UE request admission, queueing and lifecycle.
 * The network transport never enforces a global request-count limit; it only
 * carries requests that this client has admitted.
 */
export class SFVRequestManager {
  constructor({catalog,store,transport,onEvent,requestIdPrefix='r',maxConcurrentRequests=Infinity,retry={}}) {
    this.catalog=catalog;
    this.store=store;
    this.transport=transport;
    this.onEvent=onEvent;
    this.counter=1;
    this.requestIdPrefix=requestIdPrefix;
    if(maxConcurrentRequests!==Infinity && (!Number.isSafeInteger(maxConcurrentRequests)||maxConcurrentRequests<1)) {
      throw new TypeError('maxConcurrentRequests must be a positive integer or Infinity');
    }
    this.maxConcurrentRequests=maxConcurrentRequests;
    this.local=new Map();
    this.queue=[];
    this.retry=normalizeRetryPolicy(retry,'s');this.retryPending=[];this.stopped=false;
  }

  dispatch(action,now,{retryOf=null,retryAttempt=0}={}) {
    if(this.stopped)return;
    if(action.actionType===ACTION.ABORT) { this.abort(action.requestId,now,'RULE'); return; }
    if(action.actionType===ACTION.APPEND) return;
    const resourceType=action.actionType===ACTION.FETCH_MANIFEST?'manifest':action.actionType===ACTION.FETCH_INIT?'init':'media';
    const resource=this.catalog.getResourceDescriptor({resourceType,...action});
    const requestId=`${this.requestIdPrefix}${this.counter++}`;
    if(resourceType==='manifest') this.catalog.markManifestLoading(action.videoId);
    const record={requestId,resource:{...resource,bytesTotal:undefined},bytesTotal:resource.bytesTotal,
      state:REQUEST_STATE.CREATED,queuedAt:null,startTime:null,firstByteTime:null,endTime:null,
      retryOf,retryAttempt,originalAction:structuredClone(action),
      bytesDelivered:0,finalBytesDelivered:null,abortRequestedAt:null,bytesDeliveredAtAbort:null};
    this.local.set(requestId,record);
    if(this.#activeCount()<this.maxConcurrentRequests && this.queue.length===0){
      this.#start(record,now);
    }else{
      record.state=REQUEST_STATE.QUEUED; record.queuedAt=now; this.queue.push(requestId);
      this.onEvent({time:now,eventType:'REQUEST_QUEUED',requestId,resource:record.resource,
        bytesTotal:record.bytesTotal,request:structuredClone(record),triggerDecision:false});
    }
  }

  abort(requestId,now,cause='RULE') {
    const local=this.local.get(requestId);
    if(!local){
      const pending=this.retryPending.find(item=>`retry-pending-${item.retryOf}`===requestId);
      if(!pending)return false;
      this.retryPending=this.retryPending.filter(item=>item!==pending);
      this.onEvent({time:now,eventType:'REQUEST_ABORT_REQUESTED',requestId,resource:pending.resource,cause,triggerDecision:false});
      this.onEvent({time:now,eventType:'REQUEST_CANCELLED',requestId,resource:pending.resource,cause,triggerDecision:true});
      return true;
    }
    if(![REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED].includes(local.state)) return false;
    this.onEvent({time:now,eventType:'REQUEST_ABORT_REQUESTED',requestId,resource:local.resource,cause,triggerDecision:false});
    if(local.state===REQUEST_STATE.QUEUED) {
      local.state=REQUEST_STATE.CANCELLED;
      local.abortRequestedAt=now;
      local.bytesDeliveredAtAbort=0;
      local.endTime=now;
      local.finalBytesDelivered=0;
      this.queue=this.queue.filter(id=>id!==requestId);
      this.onEvent({time:now,eventType:'REQUEST_CANCELLED',requestId,resource:local.resource,
        request:structuredClone(local),cause,triggerDecision:true});
      this.#pump(now);
      return true;
    }
    return this.transport.abort(requestId,now);
  }

  cancelPlaybackRequestsForVideo(videoId,now) {
    for(const retry of [...this.retryPending]){
      if(retry.resource.videoId!==videoId)continue;
      this.retryPending=this.retryPending.filter(r=>r!==retry);
      this.onEvent({time:now,eventType:'RETRY_CANCELLED',requestId:retry.retryOf,
        resource:retry.resource,triggerDecision:false});
    }
    const cancelled=[];
    for(const request of this.list()) {
      if(![REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED].includes(request.state)||
        request.resource?.videoId!==videoId||!['init','media'].includes(request.resource?.resourceType)) continue;
      if(this.abort(request.requestId,now,'SWIPE')) {
        cancelled.push({time:now,eventType:'REQUEST_ABORT_REQUESTED',requestId:request.requestId,
          resource:request.resource,cause:'SWIPE',triggerDecision:false});
      }
    }
    return cancelled;
  }

  stopQueued(now, sessionEnded) {
    for(const pending of this.retryPending)this.onEvent({time:now,eventType:'RETRY_CANCELLED',
      requestId:pending.retryOf,resource:pending.resource,cause:sessionEnded?'SESSION_END':'SIMULATION_CUTOFF',
      triggerDecision:false});
    this.retryPending=[];this.stopped=true;
    const events=[];
    for(const requestId of [...this.queue]) {
      const local=this.local.get(requestId);
      if(!local||local.state!==REQUEST_STATE.QUEUED) continue;
      if(sessionEnded) {
        this.onEvent({time:now,eventType:'REQUEST_ABORT_REQUESTED',requestId,resource:local.resource,cause:'SESSION_END',triggerDecision:false});
        local.state=REQUEST_STATE.CANCELLED; local.abortRequestedAt=now; local.bytesDeliveredAtAbort=0;
        local.endTime=now; local.finalBytesDelivered=0;
        const event={time:now,eventType:'REQUEST_CANCELLED',requestId,resource:local.resource,request:structuredClone(local),cause:'SESSION_END',triggerDecision:false};
        this.onEvent(event); events.push(event);
      } else {
        local.state='OUTSIDE_OBSERVATION'; local.finalBytesDelivered=0;
      }
    }
    this.queue=[];
    return events;
  }

  processTransportEvent(e) {
    const r=this.transport.get(e.requestId);
    if(!r) return;
    const local=this.local.get(e.requestId);
    if(local) Object.assign(local,r);
    if(e.eventType==='REQUEST_COMPLETED') {
      const stored={...r.resource,bytesTotal:undefined};
      if(stored.resourceType==='manifest') this.catalog.markManifestAvailable(stored.videoId);
      else {
        const admission=this.store.putDetailed(stored,null,{bytes:r.finalBytesDelivered});
        if(local)local.cacheAdmitted=admission.admitted;
        if(!admission.admitted)this.onEvent({time:e.time,eventType:'CACHE_ADMISSION_REJECTED',
          requestId:e.requestId,resource:stored,reason:admission.reason,cache:admission,triggerDecision:false});
        else this.onEvent({time:e.time,eventType:'RESOURCE_CACHED',requestId:e.requestId,resource:stored,cache:admission,triggerDecision:false});
      }
    }
    this.onEvent({...e,request:r,resource:r.resource,triggerDecision:e.eventType!=='REQUEST_FIRST_BYTE' && !(e.eventType==='REQUEST_COMPLETED' && local?.cacheAdmitted===false)});
    if(e.eventType==='REQUEST_FAILED' && local && local.retryAttempt<this.retry.maxRetries && !this.stopped){
      const entry={time:e.time+this.retry.delay,resource:local.resource,
        retryOf:e.requestId,retryAttempt:local.retryAttempt+1,action:local.originalAction};
      this.retryPending.push(entry);
      this.onEvent({time:e.time,eventType:'RETRY_SCHEDULED',requestId:e.requestId,
        resource:local.resource,retryAttempt:entry.retryAttempt,dueAtS:entry.time,triggerDecision:false});
    }
    if(['REQUEST_COMPLETED','REQUEST_FAILED','REQUEST_CANCELLED'].includes(e.eventType)) this.#pump(e.time);
  }

  nextRetryTime(){return this.retryPending.length?Math.min(...this.retryPending.map(x=>x.time)):Infinity;}
  processScheduled(now){
    const due=this.retryPending.filter(x=>x.time<=now+1e-9);
    this.retryPending=this.retryPending.filter(x=>x.time>now+1e-9);
    for(const item of due){
      if(this.stopped)continue;
      this.dispatch(item.action,now,{retryOf:item.retryOf,retryAttempt:item.retryAttempt});
    }
    return due.length;
  }
  list() {
    const transportById=new Map(this.transport.list().map(r=>[r.requestId,r]));
    const out=[];
    for(const [id,local] of this.local) out.push(structuredClone(transportById.has(id)?{...local,...transportById.get(id)}:local));
    for(const item of this.retryPending)out.push({requestId:`retry-pending-${item.retryOf}`,
      resource:structuredClone(item.resource),state:REQUEST_STATE.QUEUED,
      retryAttempt:item.retryAttempt,retryOf:item.retryOf,bytesDelivered:0,
      finalBytesDelivered:0,queuedAt:item.time-this.retry.delay,startTime:null,firstByteTime:null});
    return out;
  }

  #activeCount() {
    return this.transport.list().filter(r=>[REQUEST_STATE.ACTIVE,REQUEST_STATE.CANCELLING].includes(r.state)).length;
  }

  #start(local,now) {
    const queuedAt=local.queuedAt;
    const started=this.transport.start({requestId:local.requestId,resource:local.resource,bytesTotal:local.bytesTotal,
      retryAttempt:local.retryAttempt,state:REQUEST_STATE.CREATED},now);
    Object.assign(local,started,{queuedAt,admittedAt:now,queueWaitS:queuedAt===null?0:now-queuedAt});
    this.onEvent({time:now,eventType:'REQUEST_STARTED',requestId:local.requestId,resource:local.resource,
      bytesTotal:local.bytesTotal,request:structuredClone(local),queuedAt,queueWaitS:local.queueWaitS,triggerDecision:false});
  }

  #pump(now) {
    let active=this.#activeCount();
    while(active < this.maxConcurrentRequests && this.queue.length) {
      const requestId=this.queue.shift();
      const local=this.local.get(requestId);
      if(!local || local.state!==REQUEST_STATE.QUEUED) continue;
      this.#start(local,now);
      active+=1;
    }
  }
}
