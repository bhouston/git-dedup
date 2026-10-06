// Builds every native target, packs the npm package, and checks that the packed launcher runs.
import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
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
  const tar = (args) => execFileSync('tar', args, { cwd: temp, encoding: 'utf8' });
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
  // Unix binaries must stay executable after npm unpacks them. Windows file systems record no mode bits,
  // so only Linux and macOS (including the release job) can check this.
  if (!windows)
    for (const line of tar(['-tvzf', archive]).split(/\r?\n/))
      if (/native\/(linux|darwin)-/.test(line)) assert.match(line, /^-rwx/, `not executable: ${line}`);

  // The packed launcher must find and run this platform's binary.
  tar(['-xzf', archive]);
  const version = execFileSync(process.execPath, [join(temp, 'package', 'bin', 'git-dedup.js'), '--version'], {
    encoding: 'utf8',
  });
  assert.match(version, new RegExp(`^git version .*\\(git-dedup ${manifest.version.replaceAll('.', '\\.')}\\)\\n$`));
  console.log(`${manifest.name}@${manifest.version}: ${files.length} packed files; launcher ran: ${version.trim()}`);
} finally {
  rmSync(resolve(temp), { recursive: true, force: true });
}
