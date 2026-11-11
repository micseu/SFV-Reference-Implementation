import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/** Third-party browser bundles; currently only the patched dash.js build in web/vendor/. */
export function createVendorController({ dashBundle }) {
  dashBundle = path.resolve(dashBundle);
  if (!fs.existsSync(dashBundle))
    throw new Error(
      `Patched dash.js browser bundle missing: ${dashBundle}; build your patched dash.js checkout, then run npm run install:dashjs-bundle`
    );
  const router = express.Router();

  router.get('/dash.all.min.js', (req, res) =>
    res.sendFile(dashBundle, {
      etag: false,
      lastModified: false,
      headers: { 'cache-control': 'no-store', 'access-control-allow-origin': '*' }
    })
  );

  return router;
}
