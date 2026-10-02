import assert from 'node:assert/strict';
import { execFileSync, execSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots = ['packages/core', 'packages/cli'];
const temp = mkdtempSync(join(tmpdir(), 'git-dedup-package-check-'));
const windows = process.platform === 'win32';
// pnpm is a .cmd shim on Windows, which only a shell can start. The arguments are fixed paths.
const pnpm = (args) =>
  windows
    ? execSync(['pnpm', ...args.map((arg) => `"${arg}"`)].join(' '), { stdio: 'pipe' })
    : execFileSync('pnpm', args, { stdio: 'pipe' });

try {
  const manifests = roots.map((root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  assert.equal(manifests[0].private, undefined, 'core must be publishable');
  assert.equal(manifests[1].private, undefined, 'CLI must be publishable');
  assert.equal(manifests[1].bin['git-dedup'], './dist/bin.js');
  assert.ok(manifests[1].dependencies[manifests[0].name], 'CLI must depend on core');

  for (const [i, root] of roots.entries()) {
    const destination = join(temp, String(i));
    mkdirSync(destination);
    pnpm(['--dir', root, 'pack', '--pack-destination', destination]);
    const archive = readdirSync(destination).find((name) => name.endsWith('.tgz'));
    assert.ok(archive, `${root} must produce an npm tarball`);
    // A relative archive name keeps GNU tar from reading a Windows drive letter as a remote host.
    const tar = (args) => execFileSync('tar', args, { cwd: destination, encoding: 'utf8' });
    const files = tar(['-tf', archive]).trim().split(/\r?\n/);
    for (const path of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js']) {
      assert.ok(files.includes(path), `${root} tarball missing ${path}`);
    }
    assert.ok(!files.some((file) => file.includes('node_modules') || file.endsWith('.test.js')));
    if (i === 1) assert.ok(files.includes('package/dist/bin.js'), 'CLI binary missing');

    const packed = JSON.parse(tar(['-xOf', archive, 'package/package.json']));
    assert.equal(packed.name, manifests[i].name);
    for (const range of Object.values({
      ...packed.dependencies,
      ...packed.optionalDependencies,
      ...packed.peerDependencies,
    })) {
      assert.ok(!String(range).startsWith('workspace:'), `${root} has unresolved workspace dependency`);
    }
    console.log(`${packed.name}@${packed.version}: ${files.length} packed files`);
  }
} finally {
  rmSync(resolve(temp), { recursive: true, force: true });
}
