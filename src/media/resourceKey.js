export function resourceKey(r) {
  if (r.resourceType === 'manifest') return `${r.videoId}|manifest`;
  if (r.resourceType === 'init') return `${r.videoId}|${r.mediaType}|${r.representationId}|init`;
  return `${r.videoId}|${r.mediaType}|${r.representationId}|media|${r.segmentIndex}`;
}
