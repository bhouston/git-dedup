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
// Passwordless sudo (as on CI runners) lets the check give binaries to root, like a `sudo npm install -g`.
const sudo = (args) => execFileSync('sudo', ['-n', ...args], { stdio: 'pipe' });
let rootOwned;

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

  // npm packers drop executable bits. The launcher must restore them, or, in an install this user cannot change,
  // run a cached executable copy.
  if (!windows) {
    const installed = join(temp, 'installed');
    const cache = join(temp, 'cache');
    mkdirSync(installed);
    tar(['-xzf', join('..', archive)], installed);
    const native = join(installed, 'package', 'native');
    for (const target of readdirSync(native))
      for (const name of readdirSync(join(native, target))) chmodSync(join(native, target, name), 0o644);
    try {
      sudo(['chown', '-R', '0', native]);
      rootOwned = native;
    } catch {
      console.log('package check: no passwordless sudo; checking only the chmod repair');
    }
    assert.match(run(installed, { ...process.env, XDG_CACHE_HOME: cache }), versionLine);
    const copy = join(cache, 'git-dedup', manifest.version, `${process.platform}-${process.arch}`, 'git-dedup');
    if (rootOwned) assert.ok(existsSync(copy), `launcher did not cache an executable copy at ${copy}`);
    else assert.ok(!existsSync(copy), 'launcher copied a binary it could mark executable');
  }
  console.log(`${manifest.name}@${manifest.version}: ${files.length} packed files; launcher ran: ${version.trim()}`);
} finally {
  if (rootOwned) sudo(['chown', '-R', String(process.getuid()), rootOwned]);
  rmSync(resolve(temp), { recursive: true, force: true });
}
