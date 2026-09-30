import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, readdir, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { createGitx } from '../packages/core/dist/index.js';

// A reproducible, offline proof using two real remotes over loopback Git transport.
const root = await realpath(await mkdtemp(join(tmpdir(), 'gitx-proof-')));
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
  const pool = join(store, 'pool.git');
  const poolObjects = join(pool, 'objects');
  assert.deepEqual(await api.gc(), { compacted: true });
  const poolPacks = (await readdir(join(poolObjects, 'pack'))).filter((name) => name.endsWith('.pack'));
  assert.ok(poolPacks.length > 0, 'shared pool has pack files');
  for (const name of clones) {
    const remote = name.split('-')[0];
    const consumer = join(root, name);
    assert.equal((await readFile(join(consumer, '.git', 'objects', 'info', 'alternates'), 'utf8')).trim(), poolObjects);
    assert.equal(git(consumer, 'remote', 'get-url', 'origin'), `git://127.0.0.1:${port}/team/${remote}`);
    assert.equal(git(consumer, 'rev-parse', 'HEAD'), git(join(remotes, 'team', remote), 'rev-parse', 'HEAD'));
    git(consumer, 'gc');
    git(consumer, 'fsck', '--full');
  }
  const info = await api.storeInfo();
  assert.equal(info.remoteCount, 2);
  assert.deepEqual(await api.gc(), { compacted: true });
  for (const name of clones) {
    git(join(root, name), 'fsck', '--full');
    assert.equal(git(join(root, name), 'rev-list', '--count', 'HEAD'), '3');
  }
  console.log(
    JSON.stringify(
      {
        result: 'PASS',
        remotes: 2,
        consumers: 3,
        poolPacks: poolPacks.length,
        store: info,
        checks: ['concurrent clones', 'one shared alternate path', 'fsck after pool gc', 'full consumer history'],
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
