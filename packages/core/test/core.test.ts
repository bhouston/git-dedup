import { afterEach, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtemp, mkdir, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitx, keyForRemote, type StorageReport } from '../src/index.js';

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
      GITX_ACTIVE: '1',
      GIT_CONFIG_NOSYSTEM: '1',
      ...(root ? { GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig') } : {}),
    },
  });
  if (result.status !== 0) throw new Error(`${args.join(' ')}: ${result.stderr}`);
  return result.stdout.trim();
}

function testEnv(root: string, store: string) {
  return { GITX_STORE: store, GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
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

it('clones twice into one pool and makes both consumers depend on it', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
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
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'upstream'])).toBe(0);
  expect(await api.run(['clone', fork, 'fork'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(2);
  expect(git(['rev-parse', 'HEAD'], join(root, 'upstream'))).toBe(git(['rev-parse', 'HEAD'], join(root, 'fork')));
  await expectAlternate(store, join(root, 'upstream', '.git'));
  await expectAlternate(store, join(root, 'fork', '.git'));
  git(['fsck', '--full'], join(root, 'upstream'));
  git(['fsck', '--full'], join(root, 'fork'));
});

it('caches an existing repo including a local-only commit', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  git(['config', 'user.email', 'test@example.test'], consumer);
  git(['config', 'user.name', 'Test'], consumer);
  await writeFile(join(consumer, 'unique.txt'), 'local\n');
  git(['add', '.'], consumer);
  git(['commit', '-m', 'local'], consumer);
  const localTip = git(['rev-parse', 'HEAD'], consumer);
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect((await api.cache(consumer)).cached).toBe(1);
  await expectAlternate(store, join(consumer, '.git'));
  expect(git(['rev-parse', 'HEAD'], consumer)).toBe(localTip);
  expect(git(['show', 'HEAD:unique.txt'], consumer)).toBe('local');
  git(['fsck', '--full'], consumer);
  expect((await api.storeInfo()).remoteCount).toBe(1);
});

it('removes only legacy gitx pack keeps during cache migration', async () => {
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
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect((await api.cache(consumer)).cached).toBe(1);
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
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect((await api.cache(consumer)).cached).toBe(1);
  git(['commit-graph', 'verify'], consumer);
  git(['fsck', '--full'], consumer);
});

it('removes derived commit graphs from the shared pool', async () => {
  const { root, remote, store } = await fixture();
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  const pool = join(store, 'pool.git');
  git(['commit-graph', 'write', '--reachable'], pool);
  expect(await stat(join(pool, 'objects', 'info', 'commit-graph'))).toBeDefined();
  expect((await api.cache(join(root, 'consumer'))).cached).toBe(1);
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
  const api = createGitx({ cwd: parent, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--init'])).toBe(0);
  expect(git(['show', 'HEAD:hello.txt'], join(parent, 'deps/project'))).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], join(parent, 'deps/project')));
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
  const api = createGitx({ cwd: worktree, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--init'])).toBe(0);
  const module = join(worktree, 'deps/project');
  expect(git(['show', 'HEAD:hello.txt'], module)).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], module));
  expect((await api.cache(worktree)).cached).toBe(1);
  git(['fsck', '--full'], join(root, 'parent'));
  git(['fsck', '--full'], module);
});

it('follows a remote default branch change when refreshing its pool', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
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

it('adopts objects from the common gitdir when cache runs in a worktree', async () => {
  const { root, remote, store } = await fixture();
  const parent = join(root, 'parent');
  git(['clone', remote, parent], root);
  const worktree = join(root, 'worktree');
  git(['worktree', 'add', '-b', 'second', worktree], parent);
  const api = createGitx({ cwd: worktree, env: testEnv(root, store) });
  expect((await api.cache()).cached).toBe(1);
  const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir'], worktree);
  await expectAlternate(store, common);
  expect(git(['show', 'HEAD:hello.txt'], worktree)).toBe('hello');
  git(['fsck', '--full'], worktree);
});

it('passes shallow clones to Git without creating a pool', async () => {
  const { root, remote, store } = await fixture();
  const reports: StorageReport[] = [];
  const api = createGitx({ cwd: root, env: testEnv(root, store), onStorageReport: (report) => reports.push(report) });
  expect(await api.run(['clone', '--depth', '1', remote, 'shallow'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(0);
  expect(git(['show', 'HEAD:hello.txt'], join(root, 'shallow'))).toBe('hello');
  expect(reports).toEqual([]);
});

it('reports pool reuse for accelerated clones', async () => {
  const { root, remote, store } = await fixture();
  const reports: StorageReport[] = [];
  const api = createGitx({ cwd: root, env: testEnv(root, store), onStorageReport: (report) => reports.push(report) });
  expect(await api.run(['clone', remote, 'one'])).toBe(0);
  expect(await api.run(['clone', remote, 'two'])).toBe(0);
  expect(reports.map((report) => report.poolReused)).toEqual([false, true]);
  expect(reports.map((report) => report.operation)).toEqual(['clone', 'clone']);
});

it('reports the reduction in consumer-private pack bytes during cache adoption', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const reports: StorageReport[] = [];
  const api = createGitx({ cwd: root, env: testEnv(root, store), onStorageReport: (report) => reports.push(report) });
  expect((await api.cache(consumer)).cached).toBe(1);
  expect(reports).toHaveLength(1);
  const report = reports[0]!;
  expect(report.operation).toBe('cache');
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
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
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
  const api = createGitx({ cwd: parent, env: testEnv(root, store) });
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
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', '--recurse-submodules', parentUrl, 'parent'])).toBe(0);
  const module = join(root, 'parent', 'deps/project');
  expect(git(['show', 'HEAD:hello.txt'], module)).toBe('hello');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], module));
  // VS Code's Git: Clone argument order and --recursive alias.
  expect(await api.run(['clone', parentUrl, join(root, 'parent-vscode'), '--progress', '--recursive'])).toBe(0);
  const vscodeModule = join(root, 'parent-vscode', 'deps/project');
  await expectAlternate(store, git(['rev-parse', '--absolute-git-dir'], vscodeModule));
  expect((await api.cache(join(root, 'parent'))).cached).toBe(2);
  git(['fsck', '--full'], join(root, 'parent'));
  git(['fsck', '--full'], module);
});

it('fetches remotes into namespaced refs and never prunes consumer objects', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  await writeFile(join(source, 'new.txt'), 'new remote commit');
  git(['add', '.'], source);
  git(['commit', '-m', 'advance'], source);
  git(['push', 'origin', 'main'], source);
  expect(await api.fetch()).toEqual({ fetched: 1 });
  const refs = git(['for-each-ref', '--format=%(objectname)', 'refs/gitx/remotes'], join(store, 'pool.git'));
  expect(refs).toContain(git(['rev-parse', 'HEAD'], source));
  expect(await api.gc()).toEqual({ compacted: true });
  git(['fsck', '--full'], join(root, 'consumer'));
});

it('keeps an old clone valid after a force push and pool gc', async () => {
  const { root, source, remote, store } = await fixture();
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'old'])).toBe(0);
  const old = git(['rev-parse', 'HEAD'], join(root, 'old'));
  git(['checkout', '--orphan', 'replacement'], source);
  git(['rm', '-rf', '.'], source);
  await writeFile(join(source, 'replacement.txt'), 'new history\n');
  git(['add', '.'], source);
  git(['commit', '-m', 'replacement'], source);
  git(['push', '--force', 'origin', 'HEAD:main'], source);
  expect(await api.fetch()).toEqual({ fetched: 1 });
  expect(await api.gc()).toEqual({ compacted: true });
  expect(git(['rev-parse', 'HEAD'], join(root, 'old'))).toBe(old);
  expect(git(['show', 'HEAD:hello.txt'], join(root, 'old'))).toBe('hello');
  git(['fsck', '--full'], join(root, 'old'));
});

it('leaves local LFS objects untouched when adopting', async () => {
  const { root, remote, store } = await fixture();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  const local = join(consumer, '.git', 'lfs', 'objects', 'aa', 'bb');
  await mkdir(local, { recursive: true });
  await writeFile(join(local, 'object'), 'locally authored LFS content');
  const api = createGitx({ cwd: root, env: testEnv(root, store) });
  expect((await api.cache(consumer)).cached).toBe(1);
  await expect(stat(join(store, 'lfs'))).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(join(local, 'object'), 'utf8')).toBe('locally authored LFS content');
  git(['fsck', '--full'], consumer);
});

it.each([
  { EDITOR: 'vi' },
  { VISUAL: 'code --wait' },
  { GIT_SSH_COMMAND: 'ssh' },
  { GIT_ASKPASS: '/usr/bin/false' },
  { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'core.abbrev', GIT_CONFIG_VALUE_0: '9' },
])('keeps pool sharing with caller environment %j', async (callerEnvironment) => {
  const { root, remote, store } = await fixture();
  const api = createGitx({ cwd: root, env: { ...testEnv(root, store), ...callerEnvironment } });
  expect(await api.run(['clone', remote, 'consumer'])).toBe(0);
  expect((await api.storeInfo()).remoteCount).toBe(1);
  const consumer = join(root, 'consumer');
  await expectAlternate(store, join(consumer, '.git'));
  git(['fsck', '--full'], consumer);
  expect(git(['show', 'HEAD:hello.txt'], consumer)).toBe('hello');
});
