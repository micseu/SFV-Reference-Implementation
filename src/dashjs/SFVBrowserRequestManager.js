import {normalizeRetryPolicy,isRetryableHttpError} from '../request/SFVRetryPolicy.js';
import { ACTION, REQUEST_STATE } from '../core/constants.js';
import { resourceKey } from '../media/resourceKey.js';

/** Real-time counterpart of SFVRequestManager; no hidden retry or ABR policy. */
export class SFVBrowserRequestManager {
  constructor({catalog,store,transport,resolveRequest=(_resource) => null,onEvent=()=>{},now=()=>performance.now()/1000,
    maxConcurrentRequests=Infinity,retry={}}) {
    Object.assign(this,{catalog,store,transport,resolveRequest,onEvent,now});
    this.requests = new Map();
    this.retry=normalizeRetryPolicy(retry);this.retryTimers=new Map();this.stopped=false;
    this.counter = 1;
    if(maxConcurrentRequests!==Infinity && (!Number.isSafeInteger(maxConcurrentRequests)||maxConcurrentRequests<1)){
      throw new TypeError('maxConcurrentRequests must be a positive integer or Infinity');
    }
    this.maxConcurrentRequests=maxConcurrentRequests;
    // Transport event callback can be changed only by the owner of this transport.
    this.transport.onEvent = e => this.#onTransportEvent(e);
  }
  list() {
    const actual=[...this.requests.values()].map(r=>structuredClone(r));
    const pending=[...this.retryTimers.values()].map(entry=>({requestId:entry.retryId,
      resource:structuredClone(entry.resource),state:REQUEST_STATE.QUEUED,
      retryAttempt:entry.retryAttempt,retryOf:entry.retryOf,bytesDelivered:0,
      finalBytesDelivered:0,queuedAt:entry.queuedAt,startTime:null,firstByteTime:null}));
    return [...actual,...pending];
  }
  get(requestId) { const r = this.requests.get(requestId); return r ? structuredClone(r) : null; }
  #emit(event) { this.onEvent({...event,time:event.time ?? this.now()}); }
  dispatch(action,{retryOf=null,retryAttempt=0}={}) {
    if(this.stopped)throw new Error('Request manager is stopped');
    if(action.actionType===ACTION.ABORT) return this.abort(action.requestId,'RULE');
    if(action.actionType===ACTION.APPEND) throw new Error('APPEND must go through the playback bridge');
    const resourceType=action.actionType===ACTION.FETCH_MANIFEST?'manifest':action.actionType===ACTION.FETCH_INIT?'init':'media';
    const resource=this.catalog.getResourceDescriptor({...action,resourceType});
    const key=resourceKey(resource);
    if(this.store.has(key) || this.list().some(r=>['CREATED','QUEUED','ACTIVE','CANCELLING'].includes(r.state)&&resourceKey(r.resource)===key)) {
      throw new Error(`Resource already cached or in flight: ${key}`);
    }
    const requestId=`browser-r${this.counter++}`;
    const request={requestId,resource:{...resource},state:REQUEST_STATE.CREATED,
      retryAttempt,retryOf,originalAction:structuredClone(action),
      startTime:null,firstByteTime:null,endTime:null,bytesDelivered:0,finalBytesDelivered:0,
      abortRequestedAt:null,bytesDeliveredAtAbort:null};
    this.requests.set(requestId,request);
    if(resourceType==='manifest')this.catalog.markManifestLoading(action.videoId);
    // Resolve the active request through dash.js. Future assets have only lightweight MPD metadata.
    let dashRequest;
    try { dashRequest=this.resolveRequest(resource); }
    catch(error) { this.requests.delete(requestId); if(resourceType==='manifest')this.catalog.markManifestFailed(action.videoId); throw error; }
    if(dashRequest?.url && resource.url !== dashRequest.url) {
      // A divergent URL is a contract error, not an opportunity for an invisible second fetch.
      this.requests.delete(requestId);
      if(resourceType==='manifest')this.catalog.markManifestFailed(action.videoId);
      throw new Error(`dash.js URL mismatch for ${key}: ${dashRequest.url} != ${resource.url}`);
    }
    this.options ??= new Map();
    this.options.set(requestId,{requestId,url:resource.url,range:dashRequest?.range});
    const occupied=[...this.requests.values()].filter(r=>
      [REQUEST_STATE.ACTIVE,REQUEST_STATE.CANCELLING].includes(r.state)).length;
    const earlierQueued=[...this.requests.values()].some(r=>
      r!==request && r.state===REQUEST_STATE.QUEUED);
    const willWait=occupied>=this.maxConcurrentRequests || earlierQueued;
    request.state=REQUEST_STATE.QUEUED;
    request.queuedAt=willWait?this.now():null;
    if(willWait)this.#emit({eventType:'REQUEST_QUEUED',requestId,resource,request:structuredClone(request),triggerDecision:false});
    this.#pump();
    return requestId;
  }
  #pump(){
    if(this.pumping)return;
    this.pumping=true;
    try{
      let active=[...this.requests.values()].filter(r=>
        [REQUEST_STATE.ACTIVE,REQUEST_STATE.CANCELLING].includes(r.state)).length;
      for(const request of this.requests.values()){
        if(active>=this.maxConcurrentRequests)break;
        if(request.state!==REQUEST_STATE.QUEUED)continue;
        const requestId=request.requestId;
        request.state=REQUEST_STATE.ACTIVE;
        request.startTime=this.now();
        request.admittedAt=this.now();
        if(request.queuedAt!==null){
          request.queueWaitS=request.admittedAt-request.queuedAt;
        }
        active+=1;
        // The transport emits REQUEST_STARTED, FIRST_BYTE and PROGRESS itself.
        let pending;
        try{pending=this.transport.start(this.options.get(requestId));}
        catch(error){this.#fail(requestId,error);active-=1;continue;}
        Promise.resolve(pending).then(bytes=>{
          const r=this.requests.get(requestId);
          if(!r || [REQUEST_STATE.CANCELLED,REQUEST_STATE.FAILED].includes(r.state))return;
          if(r.state===REQUEST_STATE.CANCELLING){
            r.state=REQUEST_STATE.CANCELLED;r.endTime=this.now();r.finalBytesDelivered=r.bytesDelivered;
            this.#emit({eventType:'REQUEST_CANCELLED',requestId,request:structuredClone(r),resource:r.resource,triggerDecision:true});
            this.#pump();return;
          }
          try{
            if(r.resource.resourceType==='manifest'){
              const parsed=this.catalog.resolver.parse(r.resource.videoId,bytes,r.resource.url);
              this.catalog.registerParsedManifest(r.resource.videoId,parsed);
            }else{
              const admission=this.store.putDetailed(r.resource,bytes,{bytes:bytes.byteLength});
              r.cacheAdmitted=admission.admitted;
              if(admission.admitted){
                this.#emit({eventType:'RESOURCE_CACHED',requestId,resource:r.resource,cache:admission,triggerDecision:false});
              }else{
                this.#emit({eventType:'CACHE_ADMISSION_REJECTED',requestId,resource:r.resource,
                  reason:admission.reason,cache:admission,triggerDecision:false});
              }
            }
            r.state=REQUEST_STATE.COMPLETED;r.endTime=this.now();r.finalBytesDelivered=bytes.byteLength;
            this.#emit({eventType:'REQUEST_COMPLETED',requestId,request:structuredClone(r),
              resource:r.resource,totalBytes:bytes.byteLength,triggerDecision:r.cacheAdmitted!==false});
          }catch(error){this.#fail(requestId,error,false);}
          this.#pump();
        }).catch(error=>{
          const r=this.requests.get(requestId);
          if(!r || r.state===REQUEST_STATE.CANCELLED)return;
          if(r.state===REQUEST_STATE.CANCELLING || error?.name==='AbortError'){
            r.state=REQUEST_STATE.CANCELLED;r.endTime=this.now();r.finalBytesDelivered=r.bytesDelivered;
            this.#emit({eventType:'REQUEST_CANCELLED',requestId,request:structuredClone(r),resource:r.resource,triggerDecision:true});
          }else this.#fail(requestId,error);
          this.#pump();
        });
      }
    }finally{this.pumping=false;}
  }
  #fail(requestId,error,retryable=true){
    const r=this.requests.get(requestId);
    if(!r || ['COMPLETED','FAILED','CANCELLED'].includes(r.state))return;
    r.state=REQUEST_STATE.FAILED;
    r.endTime=this.now();
    r.finalBytesDelivered=r.bytesDelivered;
    if(r.resource.resourceType==='manifest')this.catalog.markManifestFailed(r.resource.videoId);
    if(retryable && isRetryableHttpError(error))this.#scheduleRetry(r);
    this.#emit({eventType:'REQUEST_FAILED',requestId,request:structuredClone(r),resource:r.resource,
      error:String(error?.message ?? error),triggerDecision:true});
  }
  #scheduleRetry(request){
    if(this.stopped || request.retryAttempt>=this.retry.maxRetries)return;
    const {requestId,resource,retryAttempt,originalAction}=request;
    const nextAttempt=retryAttempt+1;
    this.#emit({eventType:'RETRY_SCHEDULED',requestId,resource,retryAttempt:nextAttempt,
      delayMs:this.retry.delay,triggerDecision:false});
    const retryId=`browser-retry-pending-${requestId}`;
    const queuedAt=this.now();
    const timer=setTimeout(()=>{
      this.retryTimers.delete(requestId);
      if(this.stopped)return;
      try{this.dispatch(originalAction,{retryOf:requestId,retryAttempt:nextAttempt});}
      catch(error){this.#emit({eventType:'RETRY_FAILED',requestId,resource,error:error.message,triggerDecision:false});}
    },this.retry.delay);
    this.retryTimers.set(requestId,{timer,resource,retryId,retryOf:requestId,retryAttempt:nextAttempt,queuedAt});
  }
  #cancelRetriesForVideo(videoId){
    for(const [requestId,entry] of this.retryTimers){
      if(entry.resource.videoId!==videoId)continue;
      clearTimeout(entry.timer);this.retryTimers.delete(requestId);
      this.#emit({eventType:'RETRY_CANCELLED',requestId,resource:entry.resource,triggerDecision:false});
    }
  }
  #onTransportEvent(event){
    const r=this.requests.get(event.requestId);
    if(!r)return;
    if(event.eventType==='REQUEST_STARTED'){
      r.state=REQUEST_STATE.ACTIVE;
      r.startTime=this.now();
    }else if(event.eventType==='REQUEST_FIRST_BYTE'){
      r.firstByteTime=this.now();
    }else if(event.eventType==='REQUEST_PROGRESS'){
      r.bytesDelivered=event.totalBytes;
    }else if(event.eventType==='REQUEST_COMPLETED' || event.eventType==='REQUEST_FAILED' || event.eventType==='REQUEST_CANCELLED'){
      // Commit terminal events only after the resource is parsed/cached or the promise rejects.
      return;
    }
    this.#emit({...event,time:this.now(),request:structuredClone(r),resource:r.resource,
      triggerDecision:event.eventType==='REQUEST_PROGRESS'});
  }
  abort(requestId,cause='RULE') {
    const pending=[...this.retryTimers.entries()].find(([,entry])=>entry.retryId===requestId);
    if(pending){
      const [origin,entry]=pending;clearTimeout(entry.timer);this.retryTimers.delete(origin);
      this.#emit({eventType:'REQUEST_ABORT_REQUESTED',requestId,resource:entry.resource,cause,triggerDecision:false});
      this.#emit({eventType:'REQUEST_CANCELLED',requestId,resource:entry.resource,cause,triggerDecision:true});
      return true;
    }
    const r=this.requests.get(requestId);
    if(!r || ![REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED].includes(r.state))return false;
    if(r.state===REQUEST_STATE.QUEUED){
      r.state=REQUEST_STATE.CANCELLED;r.abortRequestedAt=this.now();r.bytesDeliveredAtAbort=0;
      r.endTime=this.now();r.finalBytesDelivered=0;
      this.#emit({eventType:'REQUEST_ABORT_REQUESTED',requestId,request:structuredClone(r),resource:r.resource,cause,triggerDecision:false});
      this.#emit({eventType:'REQUEST_CANCELLED',requestId,request:structuredClone(r),resource:r.resource,cause,triggerDecision:true});
      this.#pump();return true;
    }
    r.state=REQUEST_STATE.CANCELLING;
    r.abortRequestedAt=this.now();
    r.bytesDeliveredAtAbort=r.bytesDelivered;
    this.#emit({eventType:'REQUEST_ABORT_REQUESTED',requestId,request:structuredClone(r),resource:r.resource,cause,triggerDecision:false});
    this.transport.abort(requestId);
    return true;
  }
  cancelAll(cause='SESSION_END') {
    for(const request of this.list()){
      if([REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED].includes(request.state))this.abort(request.requestId,cause);
    }
  }
  async waitForTerminal({timeoutMs=2000}={}){
    const deadline=performance.now()+timeoutMs;
    while(performance.now()<deadline){
      if(this.list().every(r=>![REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED,REQUEST_STATE.CANCELLING].includes(r.state)))return true;
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    return this.list().every(r=>![REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED,REQUEST_STATE.CANCELLING].includes(r.state));
  }
  cancelPlaybackRequestsForVideo(videoId) {
    this.#cancelRetriesForVideo(videoId);
    return this.list().filter(r=>r.resource.videoId===videoId&&['media','init'].includes(r.resource.resourceType)&&[REQUEST_STATE.ACTIVE,REQUEST_STATE.QUEUED].includes(r.state))
      .map(r=>this.abort(r.requestId,'SWIPE')).filter(Boolean).length;
  }
  reset(){
    this.stopped=true;
    for(const entry of this.retryTimers.values()){clearTimeout(entry.timer);
      this.#emit({eventType:'RETRY_CANCELLED',requestId:entry.retryOf,resource:entry.resource,
        cause:'SESSION_END',triggerDecision:false});}
    this.retryTimers.clear();
    this.transport.reset();
    for(const r of this.requests.values()){
      if(r.state===REQUEST_STATE.QUEUED){r.state=REQUEST_STATE.CANCELLED;r.endTime=this.now();r.finalBytesDelivered=0;}
    }
  }
}
