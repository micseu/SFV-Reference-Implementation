import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const patch = path.join(root, 'patches', 'dashjs-b1bde9f-CONSOLIDATED.patch');
try {
  const output = execFileSync('git', ['apply', '--numstat', patch], {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  if (!output.trim()) {
    throw new Error('git apply --numstat returned no changed files');
  }
  process.stdout.write(output);
  process.stdout.write('dash.js patch syntax: OK\n');
} catch (error) {
  const stderr = error?.stderr?.toString?.() ?? error.message;
  process.stderr.write(`dash.js patch syntax validation failed: ${stderr}\n`);
  process.exit(1);
}
