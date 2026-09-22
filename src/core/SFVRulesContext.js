export class SFVRulesContext {
  constructor({time,session,playlist,currentVideoIndex,catalog,store,requests,playback,networkHistory,userHistory,playbackHistory}) {
    Object.assign(this,{_time:time,_session:session,_playlist:playlist,_currentVideoIndex:currentVideoIndex,_catalog:catalog,_store:store,_requests:requests,_playback:playback,_networkHistory:networkHistory,_userHistory:userHistory,_playbackHistory:playbackHistory});
    Object.freeze(this);
  }
  getCurrentTime(){return this._time;}
  getSessionInfo(){return structuredClone(this._session);}
  getPlaylistState(){return {currentVideoIndex:this._currentVideoIndex,items:structuredClone(this._playlist)};}
  getCurrentVideo(){return {...structuredClone(this._playlist[this._currentVideoIndex]),playback:structuredClone(this._playback)};}
  getMediaCatalog(){return structuredClone(this._catalog);}
  getCachedResources(filter={}){return structuredClone(this._store.filter(x=>Object.entries(filter).every(([k,v])=>x.resource[k]===v)));}
  getInFlightRequests(filter={}){return structuredClone(this._requests.filter(r=>['QUEUED','ACTIVE','CANCELLING'].includes(r.state)).filter(r=>Object.entries(filter).every(([k,v])=>r[k]===v)));}
  getNetworkHistory(){return structuredClone(this._networkHistory);}
  getUserHistory(){return structuredClone(this._userHistory);}
  getPlaybackHistory(){return structuredClone(this._playbackHistory);}
  getBufferRanges(videoId){ if(videoId!==this._playback.videoId) return []; return structuredClone(this._playback.bufferRanges); }
}
