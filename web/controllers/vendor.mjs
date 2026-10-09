import fs from 'node:fs';
import path from 'node:path';
import express from 'express';

/** Third-party browser bundles; currently only the patched dash.js build. */
export function createVendorController({ dashRoot }) {
  const dashBundle = path.join(path.resolve(dashRoot), 'dist/modern/umd/dash.all.min.js');
  if (!fs.existsSync(dashBundle))
    throw new Error(
      `Patched dash.js browser bundle missing: ${dashBundle}; run npm run webpack-build-modern in your patched dash.js checkout`
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
