import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { contentTypeFor, staticOptions } from '../http.mjs';

/** DASH fixture media; with an active emulation profile responses go through the shared-capacity emulator. */
export function createMediaController({ emulator, mediaRoot }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (!emulator.profile || !['GET', 'HEAD'].includes(req.method)) return next();
    const filePath = path.resolve(mediaRoot, `.${decodeURIComponent(req.path)}`);
    if (
      !filePath.startsWith(`${mediaRoot}${path.sep}`) ||
      !fs.existsSync(filePath) ||
      !fs.statSync(filePath).isFile()
    )
      return next();
    res.setHeader('access-control-allow-origin', '*');
    // Emulator paths stay app-relative ("/media/..."), independent of SFV_BASE_PATH,
    // so fault rules and event logs are the same however the app is mounted.
    emulator.serve(req, res, {
      filePath,
      pathname: `/media${req.path}`,
      contentType: contentTypeFor(filePath)
    });
  });
  router.use(express.static(mediaRoot, staticOptions));

  return router;
}
