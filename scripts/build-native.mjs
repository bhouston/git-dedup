// Builds the native git-dedup binary into packages/cli/native/<platform>-<arch>/, where the npm launcher finds it.
//   node scripts/build-native.mjs                     # this machine only
//   node scripts/build-native.mjs --all               # every target the npm package ships
//   node scripts/build-native.mjs --version 1.2.3     # version reported by git-dedup --version
//   node scripts/build-native.mjs --cover             # with Go coverage instrumentation
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const root = resolve(import.meta.dirname, '..');
/** Node platform and architecture names, which the launcher uses, paired with Go's. */
export const targets = [
  { platform: 'linux', arch: 'x64', goos: 'linux', goarch: 'amd64' },
  { platform: 'linux', arch: 'arm64', goos: 'linux', goarch: 'arm64' },
  { platform: 'darwin', arch: 'x64', goos: 'darwin', goarch: 'amd64' },
  { platform: 'darwin', arch: 'arm64', goos: 'darwin', goarch: 'arm64' },
  { platform: 'win32', arch: 'x64', goos: 'windows', goarch: 'amd64' },
  { platform: 'win32', arch: 'arm64', goos: 'windows', goarch: 'arm64' },
];

export function binaryPath(platform = process.platform, arch = process.arch) {
  return join(
    root,
    'packages',
    'cli',
    'native',
    `${platform}-${arch}`,
    platform === 'win32' ? 'git-dedup.exe' : 'git-dedup',
  );
}

export function buildNative({ all = false, version, cover = false } = {}) {
  version ??= JSON.parse(readFileSync(join(root, 'packages', 'cli', 'package.json'), 'utf8')).version;
  const selected = all
    ? targets
    : targets.filter((target) => target.platform === process.platform && target.arch === process.arch);
  if (!selected.length) throw new Error(`No native target for ${process.platform}-${process.arch}`);
  if (all) rmSync(join(root, 'packages', 'cli', 'native'), { recursive: true, force: true });
  for (const target of selected) {
    const output = binaryPath(target.platform, target.arch);
    const coverage = cover ? ['-cover', '-coverpkg=./...'] : [];
    execFileSync(
      'go',
      [
        'build',
        '-trimpath',
        ...coverage,
        '-ldflags',
        `-s -w -X main.version=${version}`,
        '-o',
        output,
        './cmd/git-dedup',
      ],
      {
        cwd: root,
        stdio: 'inherit',
        env: { ...process.env, CGO_ENABLED: '0', GOOS: target.goos, GOARCH: target.goarch },
      },
    );
    console.log(`built ${target.platform}-${target.arch} ${version}`);
  }
}

if (import.meta.filename === process.argv[1]) {
  const args = process.argv.slice(2);
  const versionIndex = args.indexOf('--version');
  buildNative({
    all: args.includes('--all'),
    cover: args.includes('--cover'),
    version: versionIndex >= 0 ? args[versionIndex + 1] : undefined,
  });
}
