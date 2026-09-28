import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const roots = ['packages/core', 'packages/cli'];
const temp = mkdtempSync(join(tmpdir(), 'gitx-package-check-'));

try {
  const manifests = roots.map((root) => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')));
  assert.equal(manifests[0].private, undefined, 'core must be publishable');
  assert.equal(manifests[1].private, undefined, 'CLI must be publishable');
  assert.equal(manifests[1].bin.gitx, './dist/bin.js');
  assert.ok(manifests[1].dependencies[manifests[0].name], 'CLI must depend on core');

  for (const [i, root] of roots.entries()) {
    const destination = join(temp, String(i));
    mkdirSync(destination);
    execFileSync('pnpm', ['--dir', root, 'pack', '--pack-destination', destination], { stdio: 'pipe' });
    const archive = readdirSync(destination).find((name) => name.endsWith('.tgz'));
    assert.ok(archive, `${root} must produce an npm tarball`);
    const tarball = join(destination, archive);
    const files = execFileSync('tar', ['-tf', tarball], { encoding: 'utf8' }).trim().split('\n');
    for (const path of ['package/package.json', 'package/README.md', 'package/LICENSE', 'package/dist/index.js']) {
      assert.ok(files.includes(path), `${root} tarball missing ${path}`);
    }
    assert.ok(!files.some((file) => file.includes('node_modules') || file.endsWith('.test.js')));
    if (i === 1) assert.ok(files.includes('package/dist/bin.js'), 'CLI binary missing');

    const packed = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
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
