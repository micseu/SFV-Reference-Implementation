import test from 'node:test';
import assert from 'node:assert/strict';
import {SFVPlayerPool} from '../src/dashjs/SFVPlayerPool.js';

function fakePlayer() {
  const handlers = new Map();
  return {updateSettings() {}, on(name, fn) {handlers.set(name, fn);},
    initialize() {queueMicrotask(() => handlers.get('activated')?.());},
    getSFVPort() {return {resolveInit() {return null;}, resolveMedia() {return null;}, inject() {throw new Error('unexpected injection');}};},
    reset() {}};
}

test('unresolved init request identifies resource kind, representation, and URL', async t => {
  const dashjs = {MediaPlayer: Object.assign(() => ({create: fakePlayer}), {events: {STREAM_ACTIVATED: 'activated', ERROR: 'error'}})};
  const pool = new SFVPlayerPool({dashjs, videoElement: {}});
  t.after(() => pool.reset());
  await pool.activate('v1', {url: 'https://example.invalid/v1/manifest.mpd'});
  await assert.rejects(pool.inject({videoId: 'v1', mediaType: 'video', representationId: '0', resourceType: 'init',
    url: 'https://example.invalid/v1/init-0.m4s'}, new ArrayBuffer(1)), /SFV_FRAGMENT_RESOLUTION_FAILED v1\/video\/0\/init\/init: dash\.js resolveInit returned null/);
});

test('unresolved media request identifies start time and segment index', async t => {
  const dashjs = {MediaPlayer: Object.assign(() => ({create: fakePlayer}), {events: {STREAM_ACTIVATED: 'activated', ERROR: 'error'}})};
  const pool = new SFVPlayerPool({dashjs, videoElement: {}});
  t.after(() => pool.reset());
  await pool.activate('v1', {url: 'https://example.invalid/v1/manifest.mpd'});
  await assert.rejects(pool.inject({videoId: 'v1', mediaType: 'video', representationId: '0', resourceType: 'media', segmentIndex: 0,
    startS: 0, durationS: 2, url: 'https://example.invalid/v1/chunk-0-00001.m4s'}, new ArrayBuffer(1)),
    /SFV_FRAGMENT_RESOLUTION_FAILED v1\/video\/0\/media\/0: dash\.js resolveMedia returned null at time=0\.1/);
});
