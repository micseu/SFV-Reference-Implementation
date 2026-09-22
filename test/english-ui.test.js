import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const root = new URL('../',import.meta.url);
const page = name => fs.readFileSync(new URL(name,root),'utf8');

test('browser UI is English and initial playback does not require Play click',()=>{
  const browser = page('browser/index.html');
  const main = page('browser/main.js');
  assert.match(browser,/<html lang="en">/);
  assert.match(browser,/>Start Session</);
  assert.match(browser,/>Next Video</);
  assert.doesNotMatch(browser,/Retry Playback|id="retry"/);
  assert.match(browser,/id="enable-playback"[^>]*hidden>Enable Playback/);
  assert.doesNotMatch(browser,/id="play"/);
  assert.match(main,/controller\.start\(\)/);
  assert.doesNotMatch(main,/controller\.play\(\{cause:'swipe'\}\)/);
  assert.doesNotMatch(browser+main,/[\u00e4\u00f6\u00fc\u00c4\u00d6\u00dc\u00df]/);
});
