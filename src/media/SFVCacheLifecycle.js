/** Cache cleanup is tied to observed playback lifecycle, never to incoming downloads. */
export function cleanupPassedSegments(store,{videoId,positionS,protectedKeys=[]}={}){
  if(!videoId||!Number.isFinite(positionS))return [];
  const pinned=new Set(protectedKeys);
  return store.removeWhere((r,_m,key)=>r.videoId===videoId && r.resourceType==='media' &&
    Number.isFinite(r.startS)&&Number.isFinite(r.durationS)&&r.startS+r.durationS<=positionS+1e-6 && !pinned.has(key));
}
export function cleanupDepartedVideo(store,{videoId,protectedKeys=[]}={}){
  if(!videoId)return [];
  const pinned=new Set(protectedKeys);
  return store.removeWhere((r,_m,key)=>r.videoId===videoId&&!pinned.has(key));
}
