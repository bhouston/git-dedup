import { it, expect } from 'vitest';
import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, realpath, rm, access } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join, normalize } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitDedup } from '../src/index.js';

/** Stops a spawned process. On Windows, `git daemon` runs as a child of git.exe, so stop the whole tree. */
function stop(child: ChildProcess): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill();
}

it('intercepts worktree add and initializes pool-backed submodules', async () => {
  const root = await mkdtemp(join(tmpdir(), 'gitx-worktree-'));
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(root, 'config'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DEDUP_STORE: join(root, 'store'),
    GIT_DEDUP_ACTIVE: undefined,
  };
  const git = (at: string, ...args: string[]) =>
    execFileSync('git', args, { cwd: at, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  let daemon: ChildProcess | undefined;
  try {
    const team = join(root, 'team');
    await mkdir(team);
    for (const name of ['library', 'project']) {
      const path = join(team, name);
      await mkdir(path);
      git(path, 'init', '-b', 'main');
      git(path, 'config', 'user.name', 'Test');
      git(path, 'config', 'user.email', 'test@example.invalid');
      await writeFile(join(path, 'README'), `${name}\n`);
      git(path, 'add', '.');
      git(path, 'commit', '-m', 'initial');
    }
    const listener = createServer();
    await new Promise<void>((resolve, reject) => {
      listener.once('error', reject);
      listener.listen(0, '127.0.0.1', resolve);
    });
    const address = listener.address();
    if (!address || typeof address === 'string') throw new Error('Expected TCP address');
    const port = address.port;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
    daemon = spawn(
      'git',
      [
        'daemon',
        '--reuseaddr',
        '--export-all',
        '--verbose',
        '--listen=127.0.0.1',
        `--port=${port}`,
        `--base-path=${root}`,
        root,
      ],
      { env, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Git daemon startup timed out')), 10000);
      daemon!.once('error', reject);
      daemon!.once('exit', (code) => reject(new Error(`Git daemon exited ${code}`)));
      daemon!.stderr!.on('data', (chunk) => {
        if (String(chunk).includes('Ready to rumble')) {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    const project = join(team, 'project');
    const remote = `git://127.0.0.1:${port}/team/library`;
    git(project, 'submodule', 'add', remote, 'deps/library');
    git(project, 'commit', '-am', 'add library');
    const api = createGitDedup({ cwd: root, env });
    expect(await api.run(['clone', `git://127.0.0.1:${port}/team/project`, 'consumer'])).toBe(0);
    const consumer = join(root, 'consumer');
    const worker = join(root, 'worker');
    expect(await api.run(['-C', consumer, 'worktree', 'add', '--detach', worker, 'HEAD'])).toBe(0);
    const module = join(worker, 'deps/library');
    expect(await readFile(join(module, 'README'), 'utf8')).toBe('library\n');
    const moduleGitdir = git(module, 'rev-parse', '--absolute-git-dir');
    expect(moduleGitdir).toContain('/worktrees/worker/modules/deps/library');
    // Git for Windows writes `C:/x` paths; normalize compares them with Node's form.
    expect(normalize((await readFile(join(moduleGitdir, 'objects', 'info', 'alternates'), 'utf8')).trim())).toBe(
      join(await realpath(env.GIT_DEDUP_STORE), 'pool.git', 'objects'),
    );
    // Native no-checkout semantics must survive interception.
    const emptyWorker = join(root, 'empty-worker');
    expect(await api.run(['-C', consumer, 'worktree', 'add', '--detach', '--no-checkout', emptyWorker, 'HEAD'])).toBe(
      0,
    );
    await expect(access(join(emptyWorker, '.gitmodules'))).rejects.toThrow();
    git(consumer, 'fsck', '--full');
    git(worker, 'fsck', '--full');
    git(module, 'fsck', '--full');
    expect(git(module, 'show', 'HEAD:README')).toBe('library');
  } finally {
    if (daemon && daemon.exitCode === null) {
      const closed = new Promise<void>((resolve) => daemon!.once('exit', () => resolve()));
      stop(daemon);
      await closed;
    }
    await rm(root, { recursive: true, force: true });
  }
});
