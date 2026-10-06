// Builds the native git-dedup binary and runs the shared behavior suites against it.
//   node scripts/native-test.mjs [--coverage] [vitest arguments...]
// With --coverage, the binary is built with Go coverage instrumentation and every invocation during the
// tests writes coverage data, which is merged into coverage/native.out.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
const coverage = args.includes('--coverage');
const vitestArgs = args.filter((arg) => arg !== '--coverage');
const { version } = JSON.parse(readFileSync(join(root, 'packages/cli/package.json'), 'utf8'));
const binary = join(root, 'build', 'native', process.platform === 'win32' ? 'git-dedup.exe' : 'git-dedup');
const coverageData = join(root, 'coverage', 'native-raw');

execFileSync(
  'go',
  [
    'build',
    ...(coverage ? ['-cover', '-coverpkg=./...'] : []),
    '-ldflags',
    `-X main.version=${version}`,
    '-o',
    binary,
    './cmd/git-dedup',
  ],
  { cwd: root, stdio: 'inherit' },
);
const env = { ...process.env, GIT_DEDUP_BIN: binary };
if (coverage) {
  rmSync(coverageData, { recursive: true, force: true });
  mkdirSync(coverageData, { recursive: true });
  env.GOCOVERDIR = coverageData;
}
const vitest = join(root, 'node_modules', 'vitest', 'vitest.mjs');
const result = spawnSync(process.execPath, [vitest, 'run', '--config', 'vitest.native.config.ts', ...vitestArgs], {
  cwd: root,
  env,
  stdio: 'inherit',
});
if (coverage) {
  const profile = join(root, 'coverage', 'native.out');
  execFileSync('go', ['tool', 'covdata', 'textfmt', `-i=${coverageData}`, `-o=${profile}`], {
    cwd: root,
    stdio: 'inherit',
  });
  execFileSync('go', ['tool', 'covdata', 'percent', `-i=${coverageData}`], { cwd: root, stdio: 'inherit' });
}
process.exitCode = result.status ?? 1;
