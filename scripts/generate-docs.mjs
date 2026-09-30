import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = new URL('../packages/website/.generated/git-dedup.json', import.meta.url);
await mkdir(new URL('.', output), { recursive: true });
execFileSync(
  process.execPath,
  [
    fileURLToPath(new URL('../packages/cli/dist/bin.js', import.meta.url)),
    'docgen',
    '--format',
    'json',
    '--output',
    fileURLToPath(output),
  ],
  { stdio: 'inherit' },
);
