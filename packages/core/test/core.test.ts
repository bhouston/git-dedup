import { afterEach, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitDedup, keyForRemote, type StorageReport } from '../src/index.js';

const roots: string[] = [];
const daemons: ChildProcess[] = [];
afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string) {
  const root = roots.find((path) => cwd === path || cwd.startsWith(path + '/'));
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_DEDUP_ACTIVE: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(root ? { GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig') } : {}),
    },
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function testEnv(root: string, store: string) {
  return { GIT_DEDUP_STORE: store, GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitx-core-')));
  roots.push(root);
  const remote = join(root, 'remote', 'team', 'project.git');
  const source = join(root, 'source');
  await mkdir(join(root, 'remote', 'team'), { recursive: true });
  await mkdir(source);
  git(['init', '--bare', remote], root);
  git(['init', source], root);
  git(['config', 'user.email', 'test@example.test'], source);
  git(['config', 'user.name', 'Test'], source);
  await writeFile(join(source, 'hello.txt'), 'hello\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'initial'], source);
  git(['branch', '-M', 'main'], source);
  git(['remote', 'add', 'origin', remote], source);
  git(['push', '-u', 'origin', 'main'], source);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const listeningPort = typeof address === 'object' && address ? address.port : 0;
      server.close(() => resolve(listeningPort));
    });
  });
  const daemon = spawn(
    'git',
    [
      'daemon',
      '--reuseaddr',
      '--export-all',
      `--base-path=${join(root, 'remote')}`,
      '--listen=127.0.0.1',
      `--port=${port}`,
    ],
    { stdio: 'ignore' },
  );
  daemons.push(daemon);
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { root, source, remote: `git://127.0.0.1:${port}/team/project.git`, store: join(root, 'store') };
}

async function expectAlternate(store: string, consumerGitdir: string) {
  expect((await readFile(join(consumerGitdir, 'objects', 'info', 'alternates'), 'utf8')).trim()).toBe(
    join(store, 'pool.git', 'objects'),
  );
}

it('normalizes SSH and HTTPS remote identities', () => {
  expect(keyForRemote('git@github.com:team/project.git')).toBe('github.com/team/project');
  expect(keyForRemote('https://github.com/team/project.git')).toBe('github.com/team/project');
  expect(keyForRemote('/tmp/project.git')).toBeUndefined();
});

it('lists registered remotes without creating an empty store', async () => {
  const { root, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.listRemotes()).toEqual([]);
  await expect(stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('waits for a pool lock held by a live process instead of failing', async () => {
  const { root, remote, store } = await fixture();
  const lock = join(root, '.store.gitx-lock');
  await mkdir(lock);
  await writeFile(join(lock, 'owner'), `${process.pid}\n`);
  // Skip the 50 ms lock polls and release the lock after the old 1200-poll limit.
  const setTimer = globalThis.setTimeout;
  let polls = 0;
  const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((done: () => void, ms?: number) => {
    if (ms !== 50) return setTimer(done, ms);
    if (++polls === 1250) return setTimer(() => void rm(lock, { recursive: true }).then(done), 0);
    return setTimer(done, 0);
  }) as typeof setTimeout);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  try {
    expect(await api.run(['clone', remote, 'one'])).toBe(0);
  } finally {
    spy.mockRestore();
  }
  expect(polls).toBeGreaterThanOrEqual(1250);
  await expectAlternate(store, join(root, 'one', '.git'));
});

it('clones twice into one pool and makes both consumers depend on it', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'one'])).toBe(0);
  expect(await api.run(['clone', remote, 'two'])).toBe(0);
  for (const name of ['one', 'two']) {
    const consumer = join(root, name);
    expect(git(['remote', 'get-url', 'origin'], consumer)).toBe(remote);
    expect(git(['show', 'HEAD:hello.txt'], consumer)).toBe('hello');
    await expectAlternate(store, join(consumer, '.git'));
    git(['fsck', '--full'], consumer);
  }
  expect((await api.storeInfo()).remoteCount).toBe(1);
  await rm(store, { recursive: true, force: true });
  expect(() => git(['show', 'HEAD:hello.txt'], join(root, 'one'))).toThrow();
});

it('uses one pool for forks with the same commits', async () => {
  const { root, source, remote, store } = await fixture();
  const forkPath = join(root, 'remote', 'other', 'project.git');
  await mkdir(join(root, 'remote', 'other'));
  git(['clone', '--bare', source, forkPath], root);
  const fork = remote.replace('/team/', '/other/');
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'upstream'])).toBe(0);
  expect(await api.run(['clone', fork, 'fork'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(2);
  expect(await api.listRemotes()).toEqual([
    { key: '127.0.0.1_' + new URL(fork).port + '/other/project', remote: fork },
    { key: '127.0.0.1_' + new URL(remote).port + '/team/project', remote },
  ]);
  expect(git(['rev-parse', 'HEAD'], join(root, 'upstream'))).toBe(git(['rev-parse', 'HEAD'], join(root, 'fork')));
  await expectAlternate(store, join(root, 'upstream', '.git'));
  await expectAlternate(store, join(root, 'fork', '.git'));
  git(['fsck', '--full'], join(root, 'upstream'));
  git(['fsck', '--full'], join(root, 'fork'));
});

it('adds an existing repo including a local-only commit', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['config', 'user.email', 'test@example.test'], consumer);
  git(['config', 'user.name', 'Test'], consumer);
  await writeFile(join(consumer, 'unique.txt'), 'local\n');
  git(['add', '.'], consumer);
  git(['commit', '-m', 'local'], consumer);
  const localTip = git(['rev-parse', 'HEAD'], consumer);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  await expectAlternate(store, join(consumer, '.git'));
  expect(git(['rev-parse', 'HEAD'], consumer)).toBe(localTip);
  expect(git(['show', 'HEAD:unique.txt'], consumer)).toBe('local');
  git(['fsck', '--full'], consumer);
  expect((await api.storeInfo()).remoteCount).toBe(1);
});

it('skips an unchanged store add rerun without adding pins or refreshing the remote', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  const pool = join(store, 'pool.git');
  const pins = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/gitx/consumers'], pool);
  const packNames = (await readdir(join(consumer, '.git', 'objects', 'pack'))).toSorted();
  const output = vi.spyOn(process.stderr, 'write');
  try {
    expect(await api.add(consumer)).toMatchObject({
      added: 0,
      skipped: 1,
      failed: 0,
      repositories: [{ path: consumer, status: 'skipped', reason: 'already current' }],
    });
    expect(output.mock.calls.map(([message]) => String(message)).join('')).toContain('already current');
    expect(output.mock.calls.map(([message]) => String(message)).join('')).not.toContain('updating object pool');
    expect(output.mock.calls.map(([message]) => String(message)).join('')).not.toContain('packing local objects');
  } finally {
    output.mockRestore();
  }
  expect(git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/gitx/consumers'], pool)).toBe(pins);
  expect((await readdir(join(consumer, '.git', 'objects', 'pack'))).toSorted()).toEqual(packNames);
  git(['fsck', '--full'], consumer);
});

it('keeps remote URL credentials out of the store and redacts old registrations', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  // Port 9 refuses connections, so the remote refresh is deferred without prompting.
  const secretUrl = 'https://user:secret@127.0.0.1:9/team/project.git';
  git(['remote', 'set-url', 'origin', secretUrl], consumer);
  const key = keyForRemote(secretUrl)!;
  const registration = join(store, 'remotes', `${createHash('sha256').update(key).digest('hex')}.json`);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const output = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  try {
    expect((await api.add(consumer)).added).toBe(1);
    expect(await readFile(registration, 'utf8')).not.toContain('secret');
    expect(await api.listRemotes()).toEqual([{ key, remote: 'https://127.0.0.1:9/team/project.git' }]);
    expect(await api.add(consumer)).toMatchObject({ repositories: [{ status: 'skipped', reason: 'already current' }] });
  } finally {
    output.mockRestore();
  }
  await writeFile(registration, JSON.stringify({ key, remote: secretUrl }) + '\n');
  expect(await api.listRemotes()).toEqual([{ key, remote: 'https://***@127.0.0.1:9/team/project.git' }]);
});

it('pins changed local refs once and retains old tips after force updates', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['config', 'user.email', 'test@example.test'], consumer);
  git(['config', 'user.name', 'Test'], consumer);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  const original = git(['rev-parse', 'HEAD'], consumer);
  git(['checkout', '--orphan', 'replacement'], consumer);
  git(['rm', '-rf', '.'], consumer);
  await writeFile(join(consumer, 'replacement.txt'), 'replacement\n');
  git(['add', '.'], consumer);
  git(['commit', '-m', 'replacement'], consumer);
  const replacement = git(['rev-parse', 'HEAD'], consumer);
  git(['branch', '-D', 'main'], consumer);
  expect((await api.add(consumer)).added).toBe(1);
  const pool = join(store, 'pool.git');
  const pins = git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/consumers'], pool).split('\n');
  expect(pins).toContain(original);
  expect(pins).toContain(replacement);
  expect(await api.add(consumer)).toMatchObject({
    added: 0,
    skipped: 1,
    failed: 0,
    repositories: [{ path: consumer, status: 'skipped', reason: 'already current' }],
  });
  expect(git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/consumers'], pool).split('\n')).toEqual(pins);
  await api.gc();
  expect(git(['cat-file', '-t', original], pool)).toBe('commit');
  git(['fsck', '--full'], consumer);
});

it('pins distinct case-colliding ref tips without changing the consumer refs', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['config', 'user.email', 'test@example.test'], consumer);
  git(['config', 'user.name', 'Test'], consumer);
  git(['commit', '--allow-empty', '-m', 'first local tip'], consumer);
  const first = git(['rev-parse', 'HEAD'], consumer);
  git(['update-ref', 'refs/remotes/fork/Feature', first], consumer);
  git(['pack-refs', '--all'], consumer);
  git(['commit', '--allow-empty', '-m', 'second local tip'], consumer);
  const second = git(['rev-parse', 'HEAD'], consumer);
  git(['update-ref', 'refs/remotes/fork/feature', second], consumer);
  git(['tag', '-a', 'local-tag', '-m', 'tagged local tip', first], consumer);
  const tag = git(['rev-parse', 'refs/tags/local-tag'], consumer);
  const refsBefore = git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/fork'], consumer);
  expect(refsBefore).toContain(`refs/remotes/fork/Feature ${first}`);
  expect(refsBefore).toContain(`refs/remotes/fork/feature ${second}`);

  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  expect(git(['for-each-ref', '--format=%(refname) %(objectname)', 'refs/remotes/fork'], consumer)).toBe(refsBefore);
  await api.gc();
  git(['fsck', '--full'], consumer);
  const pool = join(store, 'pool.git');
  for (const oid of [first, second, tag]) {
    expect(git(['cat-file', '-t', oid], pool)).toBe(oid === tag ? 'tag' : 'commit');
    expect(git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/consumers'], pool)).toContain(oid);
  }
});

it('adopts local objects while origin is unavailable and refreshes them later', async () => {
  const { root, source, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['config', 'user.email', 'test@example.test'], consumer);
  git(['config', 'user.name', 'Test'], consumer);
  await writeFile(join(consumer, 'unique.txt'), 'local\n');
  git(['add', '.'], consumer);
  git(['commit', '-m', 'local'], consumer);
  const localTip = git(['rev-parse', 'HEAD'], consumer);
  const bare = join(root, 'remote', 'team', 'project.git');
  const unavailable = `${bare}.unavailable`;
  await rename(bare, unavailable);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const warning = vi.spyOn(process.stderr, 'write');
  try {
    expect((await api.add(consumer)).added).toBe(1);
    expect(warning.mock.calls.some(([message]) => String(message).includes('remote refresh deferred'))).toBe(true);
  } finally {
    warning.mockRestore();
  }
  await expectAlternate(store, join(consumer, '.git'));
  expect(git(['rev-parse', 'HEAD'], consumer)).toBe(localTip);
  expect(git(['show', 'HEAD:unique.txt'], consumer)).toBe('local');
  git(['fsck', '--full'], consumer);
  expect(await api.listRemotes()).toEqual([{ key: keyForRemote(remote), remote }]);

  await rename(unavailable, bare);
  await writeFile(join(source, 'later.txt'), 'later\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'later'], source);
  git(['push', 'origin', 'main'], source);
  const laterTip = git(['rev-parse', 'HEAD'], source);
  expect((await api.fetch()).fetched).toBe(1);
  git(['cat-file', '-e', laterTip], join(store, 'pool.git'));
  expect(git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/remotes'], join(store, 'pool.git'))).toContain(
    laterTip,
  );
  git(['fsck', '--full'], consumer);
});

it('returns a reason for an invalid path and a checkout without origin', async () => {
  const { root, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const missing = join(root, 'missing');
  expect(await api.add(missing)).toMatchObject({
    added: 0,
    skipped: 1,
    failed: 0,
    repositories: [{ path: missing, status: 'skipped', reason: 'not a Git repository or path is unavailable' }],
  });
  const local = join(root, 'local');
  git(['init', local], root);
  expect(await api.add(local)).toMatchObject({
    added: 0,
    skipped: 1,
    failed: 0,
    repositories: [{ path: local, status: 'skipped', reason: 'no origin remote' }],
  });
});

it('reports a storage failure without hiding its Git diagnostic', async () => {
  const { root, remote } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const result = await createGitDedup({ cwd: root, env: testEnv(root, join(root, 'source')) }).add(consumer);
  expect(result).toMatchObject({
    added: 0,
    skipped: 0,
    failed: 1,
    repositories: [{ path: consumer, status: 'failed', reason: 'Git storage operation failed' }],
  });
  expect(result.repositories[0]?.detail).toContain('Refusing to adopt a nonempty directory');
});

it('removes only legacy gitx pack keeps during adoption', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['repack', '-a', '-d'], consumer);
  const packDirectory = join(consumer, '.git', 'objects', 'pack');
  const pack = (await readdir(packDirectory)).find((name) => name.endsWith('.pack'))!;
  const legacyKeep = join(packDirectory, pack.replace(/\.pack$/, '.keep'));
  await writeFile(legacyKeep, 'gitx base pack\n');
  const unrelatedKeep = join(packDirectory, 'unrelated.keep');
  await writeFile(unrelatedKeep, 'owned by another tool\n');
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  await expect(stat(legacyKeep)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(unrelatedKeep, 'utf8')).toBe('owned by another tool\n');
  await expectAlternate(store, join(consumer, '.git'));
  expect(git(['count-objects', '-v'], consumer)).toContain('in-pack: 0');
  git(['fsck', '--full'], consumer);
});

it('rewrites an existing commit graph after repacking into the pool', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['commit-graph', 'write', '--reachable'], consumer);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  git(['commit-graph', 'verify'], consumer);
  git(['fsck', '--full'], consumer);
});

it('removes derived commit graphs from the shared pool', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  const pool = join(store, 'pool.git');
  git(['commit-graph', 'write', '--reachable'], pool);
  expect(await stat(join(pool, 'objects', 'info', 'commit-graph'))).toBeDefined();
  expect((await api.add(join(root, 'consumer'))).added).toBe(1);
  await expect(stat(join(pool, 'objects', 'info', 'commit-graph'))).rejects.toMatchObject({ code: 'ENOENT' });
  git(['fsck', '--full'], join(root, 'consumer'));
});

it('reuses a preseeded gitdir for submodule update', async () => {
  const { root, remote, store } = await fixture();
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  git(['config', 'user.email', 'test@example.test'], parent);
  git(['config', 'user.name', 'Test'], parent);
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', remote, 'deps/project'], parent);
  git(['commit', '-am', 'module'], parent);
  git(['submodule', 'deinit', '-f', '--all'], parent);
  await rm(join(parent, '.git', 'modules'), { recursive: true, force: true });
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--init'])).toBe(0);
  expect(git(['show', 'HEAD:hello.txt'], join(parent, 'deps/project'))).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], join(parent, 'deps/project')));
});

it('gives a preseeded submodule the native remote-tracking layout', async () => {
  const { root, source, remote, store } = await fixture();
  git(['push', 'origin', 'main:feature'], source);
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  git(['config', 'user.email', 'test@example.test'], parent);
  git(['config', 'user.name', 'Test'], parent);
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', remote, 'deps/project'], parent);
  git(['commit', '-am', 'module'], parent);
  git(['-c', 'protocol.git.allow=always', 'clone', '--recurse-submodules', parent, join(root, 'native')], root);
  git(['submodule', 'deinit', '-f', '--all'], parent);
  await rm(join(parent, '.git', 'modules'), { recursive: true, force: true });
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--init'])).toBe(0);
  const layout = (module: string) => [
    git(['for-each-ref', '--format=%(refname) %(symref)', 'refs/heads', 'refs/remotes'], module),
    git(['config', '--get-regexp', '^(remote|branch)\\.'], module),
  ];
  const module = join(parent, 'deps/project');
  expect(layout(module)).toEqual(layout(join(root, 'native', 'deps/project')));
  expect(git(['rev-parse', 'origin/main'], module)).toBe(git(['rev-parse', 'main'], source));
  await writeFile(join(source, 'hello.txt'), 'updated\n');
  git(['commit', '-am', 'update'], source);
  git(['push', 'origin', 'main'], source);
  git(['submodule', 'update', '--remote'], parent);
  expect(git(['rev-parse', 'HEAD'], module)).toBe(git(['rev-parse', 'main'], source));
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], module));
});

it('preseeds a submodule in a new worktree', async () => {
  const { root, remote, store } = await fixture();
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  git(['config', 'user.email', 'test@example.test'], parent);
  git(['config', 'user.name', 'Test'], parent);
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', remote, 'deps/project'], parent);
  git(['commit', '-am', 'module'], parent);
  git(['submodule', 'deinit', '-f', '--all'], parent);
  await rm(join(parent, '.git', 'modules'), { recursive: true, force: true });
  const worktree = join(root, 'worktree');
  git(['worktree', 'add', '-b', 'second', worktree], parent);
  const api = createGitDedup({ cwd: worktree, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--init'])).toBe(0);
  const module = join(worktree, 'deps/project');
  expect(git(['show', 'HEAD:hello.txt'], module)).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], module));
  expect((await api.add(worktree)).added).toBe(1);
  git(['fsck', '--full'], join(root, 'parent'));
  git(['fsck', '--full'], module);
});

it('follows a remote default branch change when refreshing its pool', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'before'])).toBe(0);
  git(['checkout', '-b', 'next'], source);
  await writeFile(join(source, 'branch.txt'), 'next\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'next'], source);
  git(['push', 'origin', 'next'], source);
  git(['symbolic-ref', 'HEAD', 'refs/heads/next'], join(root, 'remote', 'team', 'project.git'));
  expect(await api.run(['clone', remote, 'after'])).toBe(0);
  expect(git(['branch', '--show-current'], join(root, 'after'))).toBe('next');
  expect(git(['show', 'HEAD:branch.txt'], join(root, 'after'))).toBe('next');
});

it('adopts objects from the common gitdir when store add runs in a worktree', async () => {
  const { root, remote, store } = await fixture();
  const parent = join(root, 'parent');
  git(['clone', remote, parent], root);
  const worktree = join(root, 'worktree');
  git(['worktree', 'add', '-b', 'second', worktree], parent);
  const api = createGitDedup({ cwd: worktree, env: testEnv(root, store) });
  expect((await api.add()).added).toBe(1);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree);
  await expectAlternate(store, common);
  expect(git(['show', 'HEAD:hello.txt'], worktree)).toBe('hello');
  git(['fsck', '--full'], worktree);
});

it('passes shallow clones to Git without creating a pool', async () => {
  const { root, remote, store } = await fixture();
  const reports: StorageReport[] = [];
  const api = createGitDedup({
    cwd: root,
    env: testEnv(root, store),
    onStorageReport: (report) => reports.push(report),
  });
  expect(await api.run(['clone', '--depth', '1', remote, 'shallow'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(0);
  expect(git(['show', 'HEAD:hello.txt'], join(root, 'shallow'))).toBe('hello');
  expect(reports).toEqual([]);
});

it('reports pool reuse for accelerated clones', async () => {
  const { root, remote, store } = await fixture();
  const reports: StorageReport[] = [];
  const api = createGitDedup({
    cwd: root,
    env: testEnv(root, store),
    onStorageReport: (report) => reports.push(report),
  });
  expect(await api.run(['clone', remote, 'one'])).toBe(0);
  expect(await api.run(['clone', remote, 'two'])).toBe(0);
  expect(reports.map((report) => report.poolReused)).toEqual([false, true]);
  expect(reports.map((report) => report.operation)).toEqual(['clone', 'clone']);
});

it('streams pool fetch progress to stderr unless the clone is quiet', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const output = vi.spyOn(process.stderr, 'write');
  const written = () => output.mock.calls.map(([message]) => String(message)).join('');
  try {
    expect(await api.run(['clone', '--progress', remote, 'loud'])).toBe(0);
    expect(written()).toContain('Counting objects');
    output.mockClear();
    git(['commit', '--allow-empty', '-m', 'second'], join(root, 'source'));
    git(['push', 'origin', 'main'], join(root, 'source'));
    expect(await api.run(['clone', '-q', remote, 'quiet'])).toBe(0);
    expect(written()).toContain('updating object pool');
    expect(written()).not.toContain('Counting objects');
  } finally {
    output.mockRestore();
  }
});

it('reports the reduction in consumer-private pack bytes during checkout adoption', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const reports: StorageReport[] = [];
  const api = createGitDedup({
    cwd: root,
    env: testEnv(root, store),
    onStorageReport: (report) => reports.push(report),
  });
  expect((await api.add(consumer)).added).toBe(1);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.operation).toBe('add');
  expect(report.poolReused).toBe(false);
  expect(report.beforeUniqueBytes).toBeGreaterThan(0);
  expect(report.afterUniqueBytes).toBeLessThanOrEqual(report.beforeUniqueBytes!);
  expect(report.estimatedSavedBytes).toBe(report.beforeUniqueBytes! - report.afterUniqueBytes!);
});

it('passes SHA-256 repositories to Git without a mirror', async () => {
  const { root, remote, store } = await fixture();
  const bare = join(root, 'remote', 'team', 'sha.git');
  const source = join(root, 'sha-source');
  await mkdir(source);
  git(['init', '--bare', '--object-format=sha256', bare], root);
  git(['init', '--object-format=sha256'], source);
  git(['config', 'user.email', 'test@example.test'], source);
  git(['config', 'user.name', 'Test'], source);
  await writeFile(join(source, 'sha.txt'), 'sha256\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'sha'], source);
  git(['branch', '-M', 'main'], source);
  git(['remote', 'add', 'origin', bare], source);
  git(['push', '-u', 'origin', 'main'], source);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], bare);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote.replace('project.git', 'sha.git'), 'sha'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(0);
  expect(git(['show', 'HEAD:sha.txt'], join(root, 'sha'))).toBe('sha256');
});

it('preseeds nested submodules during recursive update', async () => {
  const { root, source, remote, store } = await fixture();
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', remote, 'deps/leaf'], source);
  git(['commit', '-am', 'nested'], source);
  git(['push', 'origin', 'main'], source);
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  git(['config', 'user.email', 'test@example.test'], parent);
  git(['config', 'user.name', 'Test'], parent);
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', remote, 'deps/project'], parent);
  git(['commit', '-am', 'parent'], parent);
  git(['submodule', 'deinit', '-f', '--all'], parent);
  await rm(join(parent, '.git', 'modules'), { recursive: true, force: true });
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--init', '--recursive'])).toBe(0);
  const leaf = join(parent, 'deps/project/deps/leaf');
  expect(git(['show', 'HEAD:hello.txt'], leaf)).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], leaf));
});

it('resolves relative submodule URLs against the parent remote', async () => {
  const { root, remote, store } = await fixture();
  const parentRemote = join(root, 'remote', 'team', 'parent.git');
  const parentUrl = remote.replace('project.git', 'parent.git');
  const source = join(root, 'parent-source');
  await mkdir(source);
  git(['init', '--bare', parentRemote], root);
  git(['init'], source);
  git(['config', 'user.email', 'test@example.test'], source);
  git(['config', 'user.name', 'Test'], source);
  git(['remote', 'add', 'origin', parentUrl], source);
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', '../project.git', 'deps/project'], source);
  git(['commit', '-am', 'parent'], source);
  git(['branch', '-M', 'main'], source);
  git(['remote', 'set-url', 'origin', parentRemote], source);
  git(['push', '-u', 'origin', 'main'], source);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], parentRemote);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', '--recurse-submodules', parentUrl, 'parent'])).toBe(0);
  const module = join(root, 'parent', 'deps/project');
  expect(git(['show', 'HEAD:hello.txt'], module)).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], module));
  // VS Code's Git: Clone argument order and --recursive alias.
  expect(await api.run(['clone', parentUrl, join(root, 'parent-vscode'), '--progress', '--recursive'])).toBe(0);
  const vscodeModule = join(root, 'parent-vscode', 'deps/project');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], vscodeModule));
  expect((await api.add(join(root, 'parent'))).added).toBe(2);
  const unchanged = await api.add(join(root, 'parent'));
  expect(unchanged).toMatchObject({ added: 0, skipped: 2, failed: 0 });
  expect(unchanged.repositories).toEqual([
    expect.objectContaining({ path: join(root, 'parent'), status: 'skipped', reason: 'already current' }),
    expect.objectContaining({ path: module, status: 'skipped', reason: 'already current' }),
  ]);
  git(['remote', 'remove', 'origin'], module);
  const recursive = await api.add(join(root, 'parent'));
  expect(recursive).toMatchObject({ added: 0, skipped: 2, failed: 0 });
  expect(recursive.repositories).toContainEqual(
    expect.objectContaining({ path: module, status: 'skipped', reason: 'no origin remote' }),
  );
  git(['fsck', '--full'], join(root, 'parent'));
  git(['fsck', '--full'], module);
});

it('fetches remotes into namespaced refs and never prunes consumer objects', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  await writeFile(join(source, 'new.txt'), 'new remote commit');
  git(['add', '.'], source);
  git(['commit', '-m', 'advance'], source);
  git(['push', 'origin', 'main'], source);
  expect(await api.fetch()).toMatchObject({ fetched: 1, failed: 0 });
  const refs = git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/remotes'], join(store, 'pool.git'));
  expect(refs).toContain(git(['rev-parse', 'HEAD'], source));
  expect(await api.gc()).toEqual({ compacted: true });
  git(['fsck', '--full'], join(root, 'consumer'));
});

it('continues fetching and repacks when one remote fails', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const brokenPath = join(root, 'remote', 'team', 'aaa-broken.git');
  const broken = remote.replace('project.git', 'aaa-broken.git');
  git(['clone', '--bare', join(root, 'remote', 'team', 'project.git'), brokenPath], root);
  expect(await api.run(['clone', broken, 'broken'])).toBe(0);
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  await rm(brokenPath, { recursive: true, force: true });
  await writeFile(join(source, 'new.txt'), 'new remote commit');
  git(['add', '.'], source);
  git(['commit', '-m', 'advance'], source);
  git(['push', 'origin', 'main'], source);
  const result = await api.fetch();
  expect(result).toMatchObject({ fetched: 1, failed: 1 });
  expect(result.remotes).toContainEqual(
    expect.objectContaining({ key: keyForRemote(broken), status: 'failed', reason: expect.any(String) }),
  );
  expect(result.remotes).toContainEqual({ key: keyForRemote(remote), status: 'fetched' });
  const refs = git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/remotes'], join(store, 'pool.git'));
  expect(refs).toContain(git(['rev-parse', 'HEAD'], source));
  expect(git(['count-objects', '-v'], join(store, 'pool.git'))).toMatch(/^count: 0$/m);
});

it('keeps an old clone valid after a force push and pool gc', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'old'])).toBe(0);
  const old = git(['rev-parse', 'HEAD'], join(root, 'old'));
  git(['checkout', '--orphan', 'replacement'], source);
  git(['rm', '-rf', '.'], source);
  await writeFile(join(source, 'replacement.txt'), 'new history\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'replacement'], source);
  git(['push', '--force', 'origin', 'HEAD:main'], source);
  expect(await api.fetch()).toMatchObject({ fetched: 1, failed: 0 });
  expect(await api.gc()).toEqual({ compacted: true });
  expect(git(['rev-parse', 'HEAD'], join(root, 'old'))).toBe(old);
  expect(git(['show', 'HEAD:hello.txt'], join(root, 'old'))).toBe('hello');
  git(['fsck', '--full'], join(root, 'old'));
});

it('keeps borrowed objects after a force push and automatic pool gc', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const consumer = join(root, 'consumer');
  const pool = join(store, 'pool.git');
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  git(['config', 'user.email', 'test@example.test'], consumer);
  git(['config', 'user.name', 'Test'], consumer);
  git(['checkout', '-b', 'feature'], source);
  await writeFile(join(source, 'feature.txt'), 'feature\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'feature'], source);
  git(['push', 'origin', 'feature'], source);
  expect(await api.fetch()).toEqual({ fetched: 1 });
  git(['fetch', 'origin'], consumer);
  git(['checkout', '-b', 'feature', 'origin/feature'], consumer);
  git(['commit', '--allow-empty', '-m', 'local work'], consumer);
  git(['commit', '--amend', '-m', 'rewritten feature'], source);
  git(['push', '--force', 'origin', 'feature'], source);
  // Simulate months of use: old pool objects, many packs, and eager automatic gc.
  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  for (const entry of await readdir(join(pool, 'objects'), { recursive: true }))
    await utimes(join(pool, 'objects', entry), old, old);
  await writeFile(
    join(root, 'global.gitconfig'),
    '[gc]\n\tauto = 1\n\tautoPackLimit = 1\n\tautoDetach = false\n[maintenance]\n\tautoDetach = false\n[fetch]\n\tunpackLimit = 1\n',
  );
  expect(await api.fetch()).toEqual({ fetched: 1 });
  // Newer Git maintenance may not prune after fetch, so also run gc directly.
  git(['gc', '--auto'], pool);
  expect(git(['show', 'HEAD~1:feature.txt'], consumer)).toBe('feature');
  git(['fsck', '--full'], consumer);
});

it('leaves local LFS objects untouched when adopting', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const local = join(consumer, '.git', 'lfs', 'objects', 'aa', 'bb');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'object'), 'locally authored LFS content');
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(consumer)).added).toBe(1);
  await expect(stat(join(store, 'lfs'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(local, 'object'), 'utf8')).toBe('locally authored LFS content');
  git(['fsck', '--full'], consumer);
});

it('removes a clone from the store so it survives store deletion', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  const consumer = join(root, 'consumer');
  const id = (await readFile(join(consumer, '.git', 'gitx-consumer-id'), 'utf8')).trim();
  const result = await api.remove(consumer);
  expect(result).toMatchObject({ removed: 1, skipped: 0, failed: 0 });
  expect(result.repositories[0]!.objectBytes).toBeGreaterThan(0);
  await expect(stat(join(consumer, '.git', 'objects', 'info', 'alternates'))).rejects.toMatchObject({
    code: 'ENOENT',
  });
  await expect(stat(join(consumer, '.git', 'gitx-consumer-id'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(git(['for-each-ref', `refs/gitx/consumers/${id}`], join(store, 'pool.git'))).toBe('');
  expect(await api.remove(consumer)).toMatchObject({
    removed: 0,
    skipped: 1,
    repositories: [expect.objectContaining({ reason: 'not linked to the store' })],
  });
  await rm(store, { recursive: true, force: true });
  git(['fsck', '--full'], consumer);
  expect(git(['show', 'HEAD:hello.txt'], consumer)).toBe('hello');
});

it('treats removing an unlinked checkout as a no-op without creating a store', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.remove(consumer)).toMatchObject({ removed: 0, skipped: 1, failed: 0 });
  await expect(stat(store)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('removes an adopted repo and its submodule from the store', async () => {
  const { root, remote, store } = await fixture();
  const parent = join(root, 'parent');
  git(['clone', remote, parent], root);
  git(['config', 'user.email', 'test@example.test'], parent);
  git(['config', 'user.name', 'Test'], parent);
  git(['-c', 'protocol.git.allow=always', 'submodule', 'add', remote, 'deps/project'], parent);
  git(['commit', '-am', 'module'], parent);
  const module = join(parent, 'deps/project');
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect((await api.add(parent)).added).toBe(2);
  const removed = await api.remove(parent);
  expect(removed).toMatchObject({ removed: 2, skipped: 0, failed: 0 });
  expect(removed.repositories.map((repository) => repository.path)).toEqual([parent, module]);
  await rm(store, { recursive: true, force: true });
  git(['fsck', '--full'], parent);
  git(['fsck', '--full'], module);
  expect(git(['show', 'HEAD:hello.txt'], module)).toBe('hello');
});

it('removes a linked worktree checkout through its common gitdir', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'parent'])).toBe(0);
  const parent = join(root, 'parent');
  const worktree = join(root, 'worktree');
  git(['worktree', 'add', '-b', 'second', worktree], parent);
  git(['config', 'user.email', 'test@example.test'], worktree);
  git(['config', 'user.name', 'Test'], worktree);
  await writeFile(join(worktree, 'local.txt'), 'local\n');
  git(['add', '.'], worktree);
  git(['commit', '-m', 'local'], worktree);
  expect(await api.remove(worktree)).toMatchObject({ removed: 1, skipped: 0, failed: 0 });
  await rm(store, { recursive: true, force: true });
  git(['fsck', '--full'], parent);
  git(['fsck', '--full'], worktree);
  expect(git(['show', 'HEAD:local.txt'], worktree)).toBe('local');
});

it.each([
  { EDITOR: 'vi' },
  { VISUAL: 'code --wait' },
  { GIT_SSH_COMMAND: 'ssh' },
  { GIT_ASKPASS: '/usr/bin/false' },
  { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '9' },
])('keeps pool sharing with caller environment %j', async (callerEnvironment) => {
  const { root, remote, store } = await fixture();
  const api = createGitDedup({ cwd: root, env: { ...testEnv(root, store), ...callerEnvironment } });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(1);
  const consumer = join(root, 'consumer');
  await expectAlternate(store, join(consumer, '.git'));
  git(['fsck', '--full'], consumer);
  expect(git(['show', 'HEAD:hello.txt'], consumer)).toBe('hello');
});
