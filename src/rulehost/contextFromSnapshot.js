export function contextFromSnapshot(s){
  return {
    getCurrentTime:()=>s.time,
    getSessionInfo:()=>structuredClone(s.session),
    getPlaylistState:()=>structuredClone(s.playlistState),
    getCurrentVideo:()=>structuredClone(s.currentVideo),
    getMediaCatalog:()=>structuredClone(s.mediaCatalog),
    getCachedResources:(filter={})=>structuredClone((s.cachedResources??[]).filter(x=>Object.entries(filter).every(([k,v])=>x.resource[k]===v))),
    getInFlightRequests:(filter={})=>structuredClone((s.inFlightRequests??[]).filter(x=>Object.entries(filter).every(([k,v])=>(x.resource?.[k]===v||x[k]===v)))),
    getNetworkHistory:()=>structuredClone(s.networkHistory??[]),
    getUserHistory:()=>structuredClone(s.userHistory??[]),
    getPlaybackHistory:()=>structuredClone(s.playbackHistory??[]),
    getBufferRanges:(videoId)=>videoId===s.currentVideo.videoId?structuredClone(s.currentVideo.playback?.bufferRanges??[]):[]
  };
}
export function snapshotContext(ctx){return {time:ctx.getCurrentTime(),session:ctx.getSessionInfo(),playlistState:ctx.getPlaylistState(),currentVideo:ctx.getCurrentVideo(),mediaCatalog:ctx.getMediaCatalog(),cachedResources:ctx.getCachedResources(),inFlightRequests:ctx.getInFlightRequests(),networkHistory:ctx.getNetworkHistory(),userHistory:ctx.getUserHistory(),playbackHistory:ctx.getPlaybackHistory()};}
