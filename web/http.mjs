import path from 'node:path';

/** Content types that Express does not map, or maps differently, by default. */
export const mime = { '.mpd': 'application/dash+xml', '.m4s': 'video/iso.segment' };

export const contentTypeFor = filePath =>
  mime[path.extname(filePath)] ?? 'application/octet-stream';

/** Every response bypasses caches so each experiment session fetches fresh bytes. */
export const staticOptions = {
  etag: false,
  lastModified: false,
  setHeaders(res, file) {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('cache-control', 'no-store');
    if (mime[path.extname(file)]) res.setHeader('content-type', mime[path.extname(file)]);
  }
};

export const noStore = (req, res, next) => {
  res.set('cache-control', 'no-store');
  next();
};

export const notFound = (req, res) => res.status(404).type('text').send('Not found');

// body-parser errors (bad JSON → 400, oversized → 413)
export const errorHandler = (error, req, res, next) => {
  if (res.headersSent) return next(error);
  res.status(error.status ?? 500).json({ error: error.message });
};
