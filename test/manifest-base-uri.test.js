import test from 'node:test';
import assert from 'node:assert/strict';
import {SFVDashAssetResolver} from '../src/dashjs/SFVDashAssetResolver.js';

function fakeDashParser() {
  return {
    type: 'static', mediaPresentationDuration: 2,
    Period: [{AdaptationSet: [{contentType: 'video', Representation: [{
      id: '0', bandwidth: 180000, mimeType: 'video/mp4',
      SegmentTemplate: {
        initialization: 'init-$RepresentationID$.m4s',
        media: 'chunk-$RepresentationID$-$Number%05d$.m4s',
        startNumber: 1, timescale: 1, SegmentTimeline: {S: [{t: 0, d: 2}]}
      }
    }]}]}]
  };
}

test('externally fetched MPD supplies dash.js ManifestLoader URL metadata', () => {
  const url = 'http://127.0.0.1:8080/media/v1/manifest-video-only.mpd';
  const resolver = new SFVDashAssetResolver({parseDashManifest: fakeDashParser});
  const result = resolver.parse('v1', new TextEncoder().encode('<MPD/>'), url);
  assert.equal(result.dashManifest.url, url);
  assert.equal(result.dashManifest.originalUrl, url);
  assert.equal(result.dashManifest.baseUri, 'http://127.0.0.1:8080/media/v1/');
  assert.ok(result.dashManifest.loadedTime instanceof Date);
  assert.equal(result.video.representations.video[0].initUrl,
    'http://127.0.0.1:8080/media/v1/init-0.m4s');
  assert.equal(result.video.representations.video[0].segments[0].url,
    'http://127.0.0.1:8080/media/v1/chunk-0-00001.m4s');
});

test('manifest directory rather than page origin is the base URI', () => {
  const url = 'https://cdn.example.test/feed/item42/index.mpd';
  const resolver = new SFVDashAssetResolver({parseDashManifest: fakeDashParser});
  const result = resolver.parse('v42', new TextEncoder().encode('<MPD/>'), url);
  assert.equal(result.dashManifest.baseUri, 'https://cdn.example.test/feed/item42/');
});
