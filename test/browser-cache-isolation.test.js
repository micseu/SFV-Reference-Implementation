import test from 'node:test';
import assert from 'node:assert/strict';
import {SFVHttpTransport} from '../src/dashjs/SFVHttpTransport.js';
import {clearSFVMediaCache} from '../src/browser/SFVBrowserCacheIsolation.js';

test('manifest/init/media requests always bypass the HTTP cache, including later sessions',async()=>{
  const urls=[];
  const bytes=new Uint8Array([1,2,3]);
  const fetchImpl=async(url,options)=>{
    urls.push({url,options});
    return {ok:true,body:new ReadableStream({start(controller){controller.enqueue(bytes);controller.close();}}),
      headers:new Headers({'content-length':'3'})};
  };
  for(let session=0;session<2;session++){
    const transport=new SFVHttpTransport({fetchImpl});
    for(const resourceType of ['manifest','init','media']){
      await transport.start({requestId:`${session}-${resourceType}`,url:`https://example.test/media/v1/${resourceType}`});
    }
    transport.reset();
  }
  assert.equal(urls.length,6);
  assert.ok(urls.every(row=>row.options.cache==='no-store'));
});

test('new session clears only SFV CacheStorage media entries; unrelated origin resources remain',async()=>{
  const urls=['https://example.test/media/v1/manifest-video-only.mpd',
    'https://example.test/media/v1/init-0.m4s','https://example.test/media/v1/chunk-0-00001.m4s',
    'https://example.test/other/something','https://other.test/media/v1/chunk.m4s',
    'https://cdn.test/custom/my.mpd'];
  const entries=urls.map(url=>({url}));
  const cacheStorage={keys:async()=>['unrelated-app-cache'],open:async()=>({
    keys:async()=>entries.slice(),delete:async item=>{const index=entries.indexOf(item);if(index<0)return false;
      entries.splice(index,1);return true;}})};
  const args={cacheStorage,origin:'https://example.test',playlist:[{manifestUrl:'https://cdn.test/custom/my.mpd'}]};
  const cleaned=await clearSFVMediaCache(args);
  assert.equal(cleaned.deletedEntries,4);
  assert.deepEqual(entries.map(item=>item.url),urls.slice(3,5));
  assert.equal((await clearSFVMediaCache(args)).deletedEntries,0);
  assert.equal((await clearSFVMediaCache({cacheStorage:null})).mode,'http-no-store');
});
