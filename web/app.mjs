import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { SFVMediaNetworkEmulator } from '../scripts/network/SFVMediaNetworkEmulator.mjs';
import { createControlController } from './controllers/control.mjs';
import { createMediaController } from './controllers/media.mjs';
import { createStaticController } from './controllers/static.mjs';
import { createVendorController } from './controllers/vendor.mjs';
import { errorHandler, notFound } from './http.mjs';

const webRoot = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(webRoot, '..');

/** Normalizes a mount path such as "sfv/" or "/sfv" to "/sfv"; "" and "/" mean the site root. */
export function normalizeBasePath(value = '') {
  const trimmed = String(value)
    .trim()
    .replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  const basePath = `/${trimmed}`;
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(basePath))
    throw new TypeError(
      `Invalid base path ${JSON.stringify(value)}: use path segments of letters, digits, ".", "_", "~" or "-"`
    );
  return basePath;
}

/** Serves the single-UE browser console, the shared src/ modules, DASH fixtures and the control endpoints. */
export function createApp({
  dashBundle = process.env.SFV_DASHJS_BUNDLE || path.join(webRoot, 'vendor/dash.all.min.js'),
  basePath = '',
  emulator = new SFVMediaNetworkEmulator(),
  serverInstanceId = randomUUID()
} = {}) {
  basePath = normalizeBasePath(basePath);
  const app = express();
  app.disable('x-powered-by');

  // Route table, relative to the base path. Order matters: the page files come last.
  const controllers = [
    ['/__sfv', createControlController({ emulator, serverInstanceId })],
    ['/vendor', createVendorController({ dashBundle })],
    ['/media', createMediaController({ emulator, mediaRoot: path.join(root, 'fixtures/dash') })],
    ['/src', createStaticController(path.join(root, 'src'))],
    ['/', createStaticController(path.join(webRoot, 'public'))]
  ];
  const router = express.Router();
  for (const [mountPath, controller] of controllers) router.use(mountPath, controller);

  if (basePath) {
    // The page uses relative URLs, so "/sfv" must become "/sfv/" before index.html is served.
    app.get(basePath, (req, res, next) => {
      if (req.path !== basePath) return next();
      res.redirect(308, `${basePath}/${new URL(req.originalUrl, 'http://localhost').search}`);
    });
  }
  app.use(basePath || '/', router);
  app.use(notFound);
  app.use(errorHandler);
  return app;
}
