import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashRoot = path.join(projectRoot, 'fixtures/dash');

const MIME = {
  '.mpd': 'application/dash+xml',
  '.m4s': 'video/iso.segment',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8'
};

export function createFixtureServer() {
  return http.createServer((request, response) => {
    const url = new URL(request.url, 'http://localhost');
    if (!url.pathname.startsWith('/media/')) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }

    const relative = url.pathname.slice('/media/'.length);
    const filePath = path.resolve(dashRoot, relative);
    if (!filePath.startsWith(`${dashRoot}${path.sep}`) || !fs.existsSync(filePath)) {
      response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('not found');
      return;
    }

    const stat = fs.statSync(filePath);
    if (!stat.isFile()) {
      response.writeHead(404);
      response.end();
      return;
    }

    response.writeHead(200, {
      'access-control-allow-origin': '*',
      'cache-control': 'no-store',
      'content-length': stat.size,
      'content-type': MIME[path.extname(filePath)] ?? 'application/octet-stream'
    });
    fs.createReadStream(filePath).pipe(response);
  });
}

export async function listenFixtureServer({ port = 0, host = '127.0.0.1' } = {}) {
  const server = createFixtureServer();
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const address = server.address();
  return {
    server,
    origin: `http://${host}:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}
