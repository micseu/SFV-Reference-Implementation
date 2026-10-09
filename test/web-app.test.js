import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, normalizeBasePath } from '../web/app.mjs';

function withApp(options, run) {
  return async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sfv-web-app-'));
    const bundle = path.join(tmp, 'dist/modern/umd/dash.all.min.js');
    fs.mkdirSync(path.dirname(bundle), { recursive: true });
    fs.writeFileSync(bundle, 'window.dashjs={};');
    const server = createApp({ dashRoot: tmp, ...options }).listen(0, '127.0.0.1');
    await new Promise(resolve => server.once('listening', resolve));
    try {
      await run(`http://127.0.0.1:${server.address().port}`);
    } finally {
      server.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  };
}

test('base path is normalized and rejects route pattern characters', () => {
  assert.equal(normalizeBasePath(), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath(' sfv/ '), '/sfv');
  assert.equal(normalizeBasePath('/lab/sfv-demo/'), '/lab/sfv-demo');
  for (const bad of ['/sfv/:id', '/a b', '/*', '/sfv?x=1'])
    assert.throws(() => normalizeBasePath(bad), /Invalid base path/);
});

test(
  'all routes are served under the configured base path',
  withApp({ basePath: '/sfv' }, async base => {
    const redirect = await fetch(`${base}/sfv?x=1`, { redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/sfv/?x=1');
    assert.match(await (await fetch(`${base}/sfv/`)).text(), /How would you like to start/);
    for (const route of [
      '/sfv/main.js',
      '/sfv/experiment-example.json',
      '/sfv/src/browser/SFVBrowserServerClock.js',
      '/sfv/vendor/dash.all.min.js',
      '/sfv/media/v1/manifest-video-only.mpd'
    ])
      assert.equal((await fetch(`${base}${route}`)).status, 200, route);
    assert.equal((await (await fetch(`${base}/sfv/__sfv/clock`)).json()).schemaVersion, 1);
    for (const route of ['/', '/main.js', '/__sfv/clock', '/media/v1/manifest-video-only.mpd'])
      assert.equal((await fetch(`${base}${route}`)).status, 404, route);
  })
);

test(
  'without a base path the app is served from the site root',
  withApp({}, async base => {
    assert.match(await (await fetch(`${base}/`)).text(), /How would you like to start/);
    assert.equal((await fetch(`${base}/main.js`)).status, 200);
  })
);
