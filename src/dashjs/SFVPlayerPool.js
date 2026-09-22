/** One visible dash.js playback slot; future videos are lightweight catalog/cache entries.
 * The dash.js patch provides player.getSFVPort('video') once STREAM_ACTIVATED fires (before media metadata exists).
 */
export class SFVPlayerPool {
  constructor({dashjs,videoElement,onEvent=()=>{},now=()=>performance.now()/1000}) {
    if(!dashjs?.MediaPlayer || !videoElement)throw new TypeError('dash.js and videoElement required');
    Object.assign(this,{dashjs,videoElement,onEvent,now});
    this.slot=null;this.generation=0;
  }
  async activate(videoId,parsedManifest) {
    if(!parsedManifest)throw new Error(`Manifest not available: ${videoId}`);
    if(this.slot?.videoId===videoId)return this.slot;
    this.reset();
    const generation=++this.generation;
    const player=this.dashjs.MediaPlayer().create();
    player.updateSettings({streaming:{scheduling:{externallyControlled:true}}});
    const ready=new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(new Error('dash.js stream initialization timed out')),15000);
      const accept=value=>{clearTimeout(timeout);resolve(value);};
      const fail=error=>{clearTimeout(timeout);reject(error);};
      this.pendingReject=fail;
      const events=this.dashjs.MediaPlayer.events;
      player.on(events.STREAM_ACTIVATED,()=>{
        if(this.generation!==generation)return;
        try {
          const port=player.getSFVPort?.('video');
          if(!port)throw new Error('Patched dash.js getSFVPort(video) unavailable');
          accept(port);
        } catch(error){ fail(error); }
      });
      player.on(events.ERROR,(e)=>fail(new Error(`dash.js: ${e.error?.message ?? 'playback failure'}`)));
    });
    this.slot={videoId,generation,player,port:null};
    // Parsed MPD object avoids a second, dash.js-owned MPD network request.
    player.initialize(this.videoElement,parsedManifest,false);
    try {
      const port=await ready;
      if(this.generation!==generation)throw new Error('Playback slot was replaced');
      this.pendingReject=null;
      this.slot.port=port;
      this.onEvent({time:this.now(),eventType:'PLAYBACK_SLOT_READY',videoId,triggerDecision:true});
      return this.slot;
    }catch(error){this.reset();throw error;}
  }
  resolve(resource) {
    if(!this.slot?.port || resource.videoId!==this.slot.videoId || resource.resourceType==='manifest')return null;
    const port=this.slot.port;
    if(resource.resourceType==='init')return port.resolveInit(resource.representationId);
    if(resource.resourceType==='media')return port.resolveMedia(resource.representationId,
      resource.startS+Math.min(resource.durationS/2,0.1));
    throw new Error('Unknown resource type');
  }
  async inject(resource,payload) {
    const slot=this.slot;
    if(!slot?.port || slot.videoId!==resource.videoId)throw new Error('Cannot append into inactive playback slot');
    const request=this.resolve(resource);
    if(!request){
      const identity = [resource.videoId,resource.mediaType,resource.representationId,
        resource.resourceType,resource.segmentIndex ?? 'init'].join('/');
      const detail = resource.resourceType==='init'
        ? 'dash.js resolveInit returned null; check representation.initialization and BaseURL resolution'
        : `dash.js resolveMedia returned null at time=${resource.startS+Math.min(resource.durationS/2,0.1)}; check representation.segmentInfoType and SegmentTimeline/segment availability`;
      throw new Error(`SFV_FRAGMENT_RESOLUTION_FAILED ${identity}: ${detail}; resourceUrl=${resource.url ?? 'unknown'}`);
    }
    // executeCachedRequest returns a Promise which resolves only on dash.js buffer append confirmation.
    try { await slot.port.inject(request,payload); }
    catch(error){
      if(this.slot?.generation!==slot.generation){
        const stale=new Error('SFV append cancelled by slot switch');stale.code='SFV_SLOT_REPLACED';throw stale;
      }
      throw error;
    }
    if(this.slot?.generation!==slot.generation){
      const stale=new Error('SFV append cancelled by slot switch');stale.code='SFV_SLOT_REPLACED';throw stale;
    }
  }
  finalize(lastSegmentIndex){
    const slot=this.slot;
    if(!slot?.port)throw new Error('Cannot finalize inactive playback slot');
    slot.port.finalize(lastSegmentIndex);
  }
  reset(){
    ++this.generation;
    if(this.pendingReject){const reject=this.pendingReject;this.pendingReject=null;reject(Object.assign(new Error('Playback slot reset'),{code:'SFV_SLOT_REPLACED'}));}
    if(this.slot){this.slot.port?.cancelPending?.();this.slot.player.reset();this.slot=null;}
  }
}
