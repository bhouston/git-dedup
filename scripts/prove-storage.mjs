import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readdir, stat, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createGitx } from '../packages/core/dist/index.js';

// A reproducible, offline proof using two real remotes over loopback Git transport.
const root = await mkdtemp(join(tmpdir(), 'gitx-proof-'));
const store = join(root, 'store');
const env = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: join(root, 'gitconfig'),
  GITX_STORE: store,
  GIT_TERMINAL_PROMPT: '0',
};
const git = (cwd, ...args) =>
  execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
let daemon;
try {
  const remotes = join(root, 'remotes');
  await mkdir(remotes);
  for (const name of ['alpha', 'beta']) {
    const repo = join(remotes, 'team', name);
    await mkdir(repo, { recursive: true });
    git(repo, 'init', '-b', 'main');
    git(repo, 'config', 'user.name', 'Gitx Proof');
    git(repo, 'config', 'user.email', 'proof@example.invalid');
    for (let i = 0; i < 3; i++) {
      await writeFile(join(repo, 'data.txt'), `${name} revision ${i}\n`.repeat(10000));
      git(repo, 'add', '.');
      git(repo, 'commit', '-m', `revision ${i}`);
    }
    git(repo, 'repack', '-ad');
  }
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once('error', reject);
    reservation.listen(0, '127.0.0.1', resolve);
  });
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  daemon = spawn(
    'git',
    [
      'daemon',
      '--reuseaddr',
      '--export-all',
      '--verbose',
      '--listen=127.0.0.1',
      `--port=${port}`,
      `--base-path=${remotes}`,
      remotes,
    ],
    { env, stdio: ['ignore', 'ignore', 'pipe'] },
  );
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Git daemon did not start')), 10000);
    daemon.once('error', reject);
    daemon.once('exit', (code) => reject(new Error(`Git daemon exited: ${code}`)));
    daemon.stderr.on('data', (chunk) => {
      if (String(chunk).includes('Ready to rumble')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  const api = createGitx({ cwd: root, env });
  const clones = ['alpha-one', 'alpha-two', 'beta-one'];
  await Promise.all(
    clones.map(async (name) => {
      const remote = name.split('-')[0];
      assert.equal(await api.run(['clone', `git://127.0.0.1:${port}/team/${remote}`, join(root, name)]), 0);
    }),
  );
  const packDir = (name) => join(root, name, '.git', 'objects', 'pack');
  const pack = (await readdir(packDir('alpha-one'))).find((name) => name.endsWith('.pack'));
  assert.ok(pack, 'clone contains a base pack');
  const first = await stat(join(packDir('alpha-one'), pack));
  const second = await stat(join(packDir('alpha-two'), pack));
  assert.equal(first.ino, second.ino, 'independent clones share the same pack inode');
  assert.equal(first.dev, second.dev);
  assert.ok(first.nlink >= 3, 'mirror and two consumers share the pack');
  for (const name of clones) {
    const remote = name.split('-')[0];
    assert.equal(git(join(root, name), 'remote', 'get-url', 'origin'), `git://127.0.0.1:${port}/team/${remote}`);
    assert.equal(git(join(root, name), 'rev-parse', 'HEAD'), git(join(remotes, 'team', remote), 'rev-parse', 'HEAD'));
    await assert.rejects(access(join(root, name, '.git', 'objects', 'info', 'alternates')));
    git(join(root, name), 'gc');
  }
  assert.equal((await stat(join(packDir('alpha-one'), pack))).ino, first.ino, 'kept base pack survives consumer gc');
  const info = await api.storeInfo();
  await rm(store, { recursive: true, force: true });
  for (const name of clones) {
    git(join(root, name), 'fsck', '--full');
    assert.equal(git(join(root, name), 'rev-list', '--count', 'HEAD'), '3');
    assert.equal(git(join(root, name), 'status', '--porcelain'), '');
  }
  assert.equal(await api.run(['clone', `git://127.0.0.1:${port}/team/alpha`, join(root, 'rebuilt')]), 0);
  git(join(root, 'rebuilt'), 'fsck', '--full');
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        repositories: 2,
        consumers: 3,
        sharedPackInode: first.ino,
        linkCountBeforeClear: first.nlink,
        storeBeforeClear: info,
        checks: [
          'concurrent clones',
          'shared pack inode',
          'fsck after store deletion',
          'full history after store deletion',
          'automatic store rebuild',
        ],
      },
      null,
      2,
    ),
  );
} finally {
  if (daemon && daemon.exitCode === null) {
    const closed = new Promise((resolve) => daemon.once('exit', resolve));
    daemon.kill();
    await closed;
  }
  await rm(root, { recursive: true, force: true });
}
