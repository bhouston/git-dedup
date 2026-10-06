// Builds every native target, packs the npm package, and checks that the packed launcher runs.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildNative, targets } from './build-native.mjs';

const root = 'packages/cli';
const temp = mkdtempSync(join(tmpdir(), 'git-dedup-package-check-'));
const windows = process.platform === 'win32';
// pnpm is a .cmd shim on Windows, which only a shell can start. The arguments are fixed paths.
const pnpm = (args) =>
  windows
    ? execSync(['pnpm', ...args.map((arg) => `"${arg}"`)].join(' '), { stdio: 'pipe' })
    : execFileSync('pnpm', args, { stdio: 'pipe' });

try {
  buildNative({ all: true });
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.private, undefined, 'git-dedup must be publishable');
  assert.equal(manifest.bin['git-dedup'], './bin/git-dedup.js');
  assert.deepEqual(manifest.dependencies ?? {}, {}, 'the launcher needs no dependencies');

  pnpm(['--dir', root, 'pack', '--pack-destination', temp]);
  const archive = readdirSync(temp).find((name) => name.endsWith('.tgz'));
  assert.ok(archive, 'git-dedup must produce an npm tarball');
  // A relative archive name keeps GNU tar from reading a Windows drive letter as a remote host.
  const tar = (args, cwd = temp) => execFileSync('tar', args, { cwd, encoding: 'utf8' });
  const files = tar(['-tf', archive]).trim().split(/\r?\n/);
  const expected = [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/bin/git-dedup.js',
    ...targets.map(
      ({ platform, arch }) => `package/native/${platform}-${arch}/git-dedup${platform === 'win32' ? '.exe' : ''}`,
    ),
  ];
  for (const path of expected) assert.ok(files.includes(path), `tarball missing ${path}`);
  assert.ok(!files.some((file) => file.includes('node_modules') || file.endsWith('.ts')));

  const versionLine = new RegExp(`^git version .*\\(git-dedup ${manifest.version.replaceAll('.', '\\.')}\\)\\n$`);
  const run = (directory, env = process.env) =>
    execFileSync(process.execPath, [join(directory, 'package', 'bin', 'git-dedup.js'), '--version'], {
      encoding: 'utf8',
      env,
    });

  // The packed launcher must find and run this platform's binary.
  tar(['-xzf', archive]);
  const version = run(temp);
  assert.match(version, versionLine);

  // npm packers drop executable bits, and a root-owned global install cannot restore them. The launcher must
  // then run a cached executable copy. Simulate that with binaries that are neither executable nor writable.
  if (!windows) {
    const readOnly = join(temp, 'read-only');
    const cache = join(temp, 'cache');
    mkdirSync(readOnly);
    tar(['-xzf', join('..', archive)], readOnly);
    const native = join(readOnly, 'package', 'native');
    for (const target of readdirSync(native)) {
      chmodSync(join(native, target, readdirSync(join(native, target))[0]), 0o444);
      chmodSync(join(native, target), 0o555);
    }
    assert.match(run(readOnly, { ...process.env, XDG_CACHE_HOME: cache }), versionLine);
    // Root may chmod anything, so only an unprivileged run needs the cached copy.
    if (process.getuid?.() !== 0) {
      const copy = join(cache, 'git-dedup', manifest.version, `${process.platform}-${process.arch}`, 'git-dedup');
      assert.ok(existsSync(copy), `launcher did not cache an executable copy at ${copy}`);
    }
    for (const target of readdirSync(native)) chmodSync(join(native, target), 0o755);
  }
  console.log(`${manifest.name}@${manifest.version}: ${files.length} packed files; launcher ran: ${version.trim()}`);
} finally {
  rmSync(resolve(temp), { recursive: true, force: true });
}
