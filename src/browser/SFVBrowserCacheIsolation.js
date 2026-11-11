/** Remove SFV media entries from origin CacheStorage before a session starts.
 * HTTP cache eviction is not exposed to page JavaScript; the player therefore
 * additionally uses fetch(cache:'no-store') for every manifest/init/media request.
 * CacheStorage deletion is best-effort and never clears unrelated origin data.
 */
export async function clearSFVMediaCache({
  cacheStorage = globalThis.caches,
  origin = globalThis.location?.origin,
  playlist = [],
  mediaPathPrefix = '/media/'
} = {}) {
  const manifestUrls = new Set(
    playlist
      .map(item => item.manifestUrl)
      .filter(Boolean)
      .map(url => new URL(url, origin).href)
  );
  if (!cacheStorage)
    return { mode: 'http-no-store', cacheStorageAvailable: false, deletedEntries: 0 };
  let deletedEntries = 0;
  const failures = [];
  for (const name of await cacheStorage.keys()) {
    const cache = await cacheStorage.open(name);
    for (const request of await cache.keys()) {
      const url = new URL(request.url);
      const sfvMedia = url.origin === origin && url.pathname.startsWith(mediaPathPrefix);
      if (!sfvMedia && !manifestUrls.has(url.href)) continue;
      try {
        if (await cache.delete(request)) deletedEntries++;
      } catch (error) {
        failures.push(`${name}: ${error.message}`);
      }
    }
  }
  return { mode: 'http-no-store', cacheStorageAvailable: true, deletedEntries, failures };
}
