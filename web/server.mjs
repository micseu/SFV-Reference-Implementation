import { createApp, normalizeBasePath } from './app.mjs';

const host = process.env.SFV_HOST || '127.0.0.1';
const basePath = normalizeBasePath(process.env.SFV_BASE_PATH);

const server = createApp({ basePath }).listen(Number(process.env.PORT ?? 8080), host, error => {
  if (error) throw error;
  const urlHost = host.includes(':') ? `[${host}]` : host;
  console.log(`SFV browser demo: http://${urlHost}:${server.address().port}${basePath}/`);
});
