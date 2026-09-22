import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { SFVHttpTransport } from '../src/dashjs/SFVHttpTransport.js';
import { listenFixtureServer } from '../scripts/fixture-server-lib.mjs';

const dataset = JSON.parse(
  fs.readFileSync(new URL('../fixtures/content/content.json', import.meta.url))
);

test('real HTTP transport fetches the generated DASH fixture and emits normalized lifecycle events', async (t) => {
  const fixture = await listenFixtureServer();
  t.after(() => fixture.close());
  const events = [];
  const transport = new SFVHttpTransport({ onEvent: (event) => events.push(event) });
  const manifest = dataset.videos[0];
  const bytes = await transport.start({
    requestId: 'http-1',
    url: `${fixture.origin}${manifest.manifestUrl}`
  });

  assert.equal(bytes.byteLength, manifest.manifestBytes);
  assert.equal(events[0].eventType, 'REQUEST_STARTED');
  assert.ok(events.some((event) => event.eventType === 'REQUEST_FIRST_BYTE'));
  assert.ok(events.some((event) => event.eventType === 'REQUEST_PROGRESS'));
  assert.equal(events.at(-1).eventType, 'REQUEST_COMPLETED');
});
