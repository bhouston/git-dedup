// Runs the behavior suites against a coverage-instrumented binary and writes the Go profile to coverage/native.out.
//   node scripts/native-test.mjs --coverage [vitest arguments...]
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildNative } from './build-native.mjs';

const root = resolve(import.meta.dirname, '..');
const vitestArgs = process.argv.slice(2).filter((arg) => arg !== '--coverage');
const coverageData = join(root, 'coverage', 'native-raw');

buildNative({ cover: true });
rmSync(coverageData, { recursive: true, force: true });
mkdirSync(coverageData, { recursive: true });
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', ...vitestArgs], {
  cwd: root,
  env: { ...process.env, GOCOVERDIR: coverageData },
  stdio: 'inherit',
});
const profile = join(root, 'coverage', 'native.out');
execFileSync('go', ['tool', 'covdata', 'textfmt', `-i=${coverageData}`, `-o=${profile}`], {
  cwd: root,
  stdio: 'inherit',
});
execFileSync('go', ['tool', 'covdata', 'percent', `-i=${coverageData}`], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
