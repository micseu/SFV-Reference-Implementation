import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runBrowserReplay } from './browser-replay.mjs';

/** Execute the two recorded-Browser acceptance cases independently, preserving
 * failed replay artifacts for diagnosis. Browser inputs are external research
 * artifacts, never checked into the public standalone repository. */
export function runAcceptanceCases({ b1Path, b2Path, outputDirectory }) {
  if (!b1Path || !b2Path || !outputDirectory)
    throw new TypeError('B1 JSON, B2 JSON and output directory required');
  const cases = [];
  for (const [name, input] of [
    ['B1', b1Path],
    ['B2', b2Path]
  ]) {
    const bytes = fs.readFileSync(input);
    const browser = JSON.parse(bytes.toString('utf8'));
    if (
      browser.browserExperiment?.profile?.configuration?.abr?.name !==
      (name === 'B1' ? 'current' : 'prefetch')
    ) {
      throw new TypeError(`${name} export has the wrong ABR rule`);
    }
    const report = runBrowserReplay(browser, {
      outputDirectory: path.join(outputDirectory, name),
      sourceSha256: crypto.createHash('sha256').update(bytes).digest('hex')
    });
    const requests = report.checks.find(c =>
      c.label.startsWith('Completed request resources match')
    );
    const representations = report.checks.find(
      c => c.label === 'Available first-active-segment ABR choices match'
    );
    const manifest = report.checks.find(c =>
      c.label.startsWith('Browser and simulator use identical video-only')
    );
    cases.push({
      name,
      status: report.status,
      passed: report.checks.filter(c => c.passed).length,
      total: report.checks.length,
      manifestParity: manifest?.passed === true,
      representationParity: representations?.passed === true,
      resourceParity: requests?.passed === true,
      failures: report.checks.filter(c => !c.passed).map(c => c.label)
    });
  }
  fs.mkdirSync(outputDirectory, { recursive: true });
  const summary = {
    schemaVersion: 1,
    validation: 'browser-platform-trace-conditioned',
    status: cases.every(
      c =>
        c.status === 'within-configured-tolerances' &&
        c.manifestParity &&
        c.representationParity &&
        c.resourceParity
    )
      ? 'accepted'
      : 'review-required',
    cases
  };
  fs.writeFileSync(
    path.join(outputDirectory, 'acceptance-summary.json'),
    JSON.stringify(summary, null, 2) + '\n'
  );
  return summary;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [b1Path, b2Path, outputDirectory] = process.argv.slice(2);
  if (!b1Path || !b2Path || !outputDirectory) {
    console.error(
      'Usage: node scripts/validation/browser-replay-acceptance.mjs <B1-browser-session.json> <B2-browser-session.json> <output-dir>'
    );
    process.exitCode = 2;
  } else
    try {
      const summary = runAcceptanceCases({ b1Path, b2Path, outputDirectory });
      console.log(JSON.stringify(summary, null, 2));
      if (summary.status !== 'accepted') process.exitCode = 1;
    } catch (error) {
      console.error(error.stack ?? String(error));
      process.exitCode = 1;
    }
}
