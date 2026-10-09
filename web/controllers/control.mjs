import { performance } from 'node:perf_hooks';
import express from 'express';
import { noStore } from '../http.mjs';

/** Control endpoints used by the browser console: server clock and network emulation profile. */
export function createControlController({ emulator, serverInstanceId }) {
  const router = express.Router();
  router.use(noStore);

  router.get('/clock', (req, res) =>
    res.json({
      schemaVersion: 1,
      clock: 'node_performance_seconds',
      serverInstanceId,
      serverTimeS: performance.now() / 1000,
      serverUnixTimeMs: Date.now()
    })
  );

  router
    .route('/emulation')
    .get((req, res) => res.json({ ...emulator.snapshot(), serverInstanceId }))
    .post(express.json({ limit: '64kb', strict: false, type: () => true }), (req, res) => {
      try {
        const profile = req.body;
        if (profile === undefined) throw new Error('Missing emulation profile body');
        if (profile === null || profile.enabled === false) emulator.disable();
        else emulator.configure(profile);
        res.json({ ...emulator.snapshot(), serverInstanceId });
      } catch (error) {
        res.status(/active/i.test(error.message) ? 409 : 400).json({ error: error.message });
      }
    })
    .all((req, res) => res.status(405).json({}));

  return router;
}
