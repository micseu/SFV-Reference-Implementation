/**
 * Install the consolidated, opt-in SFV integration on one pinned, clean dash.js
 * checkout. Compatible with Windows, Linux and macOS; no destructive git reset.
 *
 * node scripts/prepare-dashjs.mjs ../dash.js --check
 * node scripts/prepare-dashjs.mjs ../dash.js --apply
 * node scripts/prepare-dashjs.mjs ../dash.js --verify-installed
 * node scripts/prepare-dashjs.mjs ../dash.js --install-bundle
 *
 * --install-bundle verifies the patched checkout like --verify-installed, then copies the
 * webpack-build-modern bundle into web/vendor/, where the browser web app serves it from.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const EXPECTED = 'b1bde9f45f35e4565eaeb1ea4dfd6a5f8fd44bdb';
const scriptRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dashRoot = path.resolve(process.argv[2] ?? '../dash.js');
const mode = process.argv[3] ?? '--check';
if (!['--check', '--apply', '--verify-installed', '--install-bundle'].includes(mode)) {
  throw new Error(
    'Usage: node scripts/prepare-dashjs.mjs ../dash.js --check|--apply|--verify-installed|--install-bundle'
  );
}
const run = (exe, args) => execFileSync(exe, args, { cwd: dashRoot, encoding: 'utf8' }).trim();
const head = run('git', ['rev-parse', 'HEAD']);
if (head !== EXPECTED) {
  throw new Error(
    `Unsupported dash.js commit ${head}; expected ${EXPECTED}. Use a clean pinned checkout.`
  );
}
const apiFile = path.join(
  dashRoot,
  'test',
  'unit',
  'test',
  'streaming',
  'streaming.MediaPlayerApiSurface.js'
);
const apiText = fs.readFileSync(apiFile, 'utf8');
const apiMatch = /const\s+PUBLIC_API\s*=\s*\[[\s\S]*?\]\s*\.sort\(\)\s*;/.exec(apiText);
if (!apiMatch) {
  throw new Error(
    'Expected dash.js PUBLIC_API array ending in ].sort(); was not found. Review this checkout before patching.'
  );
}
const hasPort = apiMatch[0].includes("'getSFVPort'");
const hasParser = apiMatch[0].includes("'parseSFVManifest'");
const patch = path.join(scriptRoot, 'patches', 'dashjs-b1bde9f-CONSOLIDATED.patch');

if (mode === '--verify-installed' || mode === '--install-bundle') {
  if (!hasPort || !hasParser) {
    throw new Error('dash.js API-surface test does not declare both SFV methods.');
  }
  const processor = fs.readFileSync(
    path.join(dashRoot, 'src/streaming/StreamProcessor.js'),
    'utf8'
  );
  const fragments = fs.readFileSync(
    path.join(dashRoot, 'src/streaming/models/FragmentModel.js'),
    'utf8'
  );
  const coreApi = fs.readFileSync(
    path.join(dashRoot, 'src/streaming/mediaplayer/CoreApi.js'),
    'utf8'
  );
  const checks = [
    [
      processor.includes('e.representationId !== request.representation.id'),
      'buffer append event matches request.representation.id'
    ],
    [
      fragments.includes('const sameCachedResource = previous =>'),
      'cached fragments deduplicate by type and representation'
    ],
    [processor.includes('function getSFVPort()'), 'stream processor exposes SFV port'],
    [coreApi.includes('function parseSFVManifest(xml)'), 'MediaPlayer exposes native MPD parser'],
    [!processor.includes('if (!rep) throw'), 'SFV stream port uses dash.js curly-brace convention'],
    [
      !coreApi.includes('externallyControlled) return null;'),
      'SFV CoreApi uses dash.js curly-brace convention'
    ]
  ];
  const failures = checks.filter(([ok]) => !ok).map(([, description]) => description);
  if (failures.length) {
    throw new Error(`SFV integration is incomplete: ${failures.join('; ')}`);
  }
  if (mode === '--install-bundle') {
    installBundle();
    process.exit(0);
  }
  console.log(
    `VERIFIED: SFV integrated in dash.js ${head}. Run npm run ci:verify and npm run webpack-build-modern.`
  );
  process.exit(0);
}

// A fresh install must be made only on an unmodified upstream source tree.
const tracked = run('git', ['status', '--porcelain', '--untracked-files=no']);
if (tracked) {
  throw new Error(
    `Tracked dash.js files are already modified. Do not reapply the SFV patch.\n${tracked}\nUse --verify-installed on a previously patched checkout.`
  );
}
if (hasPort || hasParser) {
  throw new Error('SFV public API methods already listed; expected an unmodified checkout.');
}
function addEntry(list, anchor, addition) {
  if (list.split(anchor).length !== 2) {
    throw new Error(
      `Expected exactly one API list anchor ${JSON.stringify(anchor)}; refusing an ambiguous change.`
    );
  }
  return list.replace(anchor, anchor + '\n    ' + addition);
}
let nextList = addEntry(apiMatch[0], "'getSafeAverageThroughput',", "'getSFVPort',");
nextList = addEntry(nextList, "'pause',", "'parseSFVManifest',");
const nextApiText =
  apiText.slice(0, apiMatch.index) + nextList + apiText.slice(apiMatch.index + apiMatch[0].length);
run('git', ['apply', '--check', '--ignore-whitespace', patch]);
if (mode === '--check') {
  console.log(
    `READY: ${head}. Consolidated patch and API-test changes pass preflight; no files changed.`
  );
} else {
  run('git', ['apply', '--ignore-whitespace', patch]);
  try {
    fs.writeFileSync(apiFile, nextApiText, 'utf8');
  } catch (error) {
    run('git', ['apply', '--reverse', '--ignore-whitespace', patch]);
    throw error;
  }
  console.log('APPLIED: one consolidated SFV source patch + two API-surface-test entries.');
  console.log('NEXT: node scripts/prepare-dashjs.mjs ../dash.js --verify-installed');
  console.log('Then run npm ci, npm run ci:verify, npm run webpack-build-modern in dash.js.');
}

/** Copies the patched dash.js browser bundle, its licenses and a build record into web/vendor/. */
function installBundle() {
  const buildDir = path.join(dashRoot, 'dist/modern/umd');
  const bundle = path.join(buildDir, 'dash.all.min.js');
  if (!fs.existsSync(bundle)) {
    throw new Error(
      `Bundle missing: ${bundle}. Run npm run webpack-build-modern in dash.js first.`
    );
  }
  // The bundle must come from the patched sources, not from an earlier unpatched build.
  const modified = run('git', ['diff', '--name-only', 'HEAD']).split('\n').filter(Boolean);
  const newestSourceMs = Math.max(
    ...modified.map(file => fs.statSync(path.join(dashRoot, file)).mtimeMs)
  );
  if (fs.statSync(bundle).mtimeMs < newestSourceMs) {
    throw new Error(
      'Bundle is older than the patched dash.js sources. Run npm run webpack-build-modern again.'
    );
  }
  const bytes = fs.readFileSync(bundle);
  const missing = ['getSFVPort', 'parseSFVManifest'].filter(name => !bytes.includes(name));
  if (missing.length) {
    throw new Error(`Bundle does not expose the SFV methods ${missing.join(', ')}; rebuild it.`);
  }
  const sha256 = data => crypto.createHash('sha256').update(data).digest('hex');
  const vendorDir = path.join(scriptRoot, 'web/vendor');
  fs.mkdirSync(vendorDir, { recursive: true });
  fs.copyFileSync(bundle, path.join(vendorDir, 'dash.all.min.js'));
  fs.copyFileSync(`${bundle}.LICENSE.txt`, path.join(vendorDir, 'dash.all.min.js.LICENSE.txt'));
  fs.copyFileSync(path.join(dashRoot, 'LICENSE.md'), path.join(vendorDir, 'dashjs-LICENSE.md'));
  const record = {
    schemaVersion: 1,
    dashjsCommit: head,
    patch: path.relative(scriptRoot, patch).split(path.sep).join('/'),
    patchSha256: sha256(fs.readFileSync(patch)),
    build: 'npm run webpack-build-modern',
    bundleSha256: sha256(bytes),
    bundleBytes: bytes.length
  };
  fs.writeFileSync(
    path.join(vendorDir, 'dashjs-build.json'),
    JSON.stringify(record, null, 2) + '\n'
  );
  console.log(
    `INSTALLED: web/vendor/dash.all.min.js from dash.js ${head} (sha256 ${record.bundleSha256}).`
  );
}
