import { afterEach, expect, it, vi } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, sep } from 'node:path';
import { createGitDedup, keyForRemote, nativeBinary } from './native.js';

/** Stops a spawned process. On Windows, `git daemon` runs as a child of git.exe, so stop the whole tree. */
function stop(child: ChildProcess): void {
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore' });
  else child.kill();
}

const windows = process.platform === 'win32';
const realGit = spawnSync(windows ? 'where' : 'which', ['git'], { encoding: 'utf8' })
  .stdout.split(/\r?\n/)[0]!
  .trim();
const roots: string[] = [];
const daemons: ChildProcess[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const daemon of daemons.splice(0)) stop(daemon);
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

function git(args: string[], cwd: string) {
  const root = roots.find((path) => cwd === path || cwd.startsWith(path + sep));
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

const testEnv = (root: string, store: string, extra: NodeJS.ProcessEnv = {}) => ({
  GIT_DEDUP_STORE: store,
  GIT_CONFIG_GLOBAL: join(root, 'global.gitconfig'),
  GIT_CONFIG_NOSYSTEM: '1',
  ...extra,
});

async function tmp() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitx-edge-')));
  roots.push(root);
  return root;
}

async function fixture() {
  const root = await tmp();
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
  daemons.push(
    spawn(
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
    ),
  );
  await new Promise((resolve) => setTimeout(resolve, 150));
  return { root, source, remote: `git://127.0.0.1:${port}/team/project.git`, store: join(root, 'store') };
}

/** Captures stderr so fallback notices do not pollute test output. */
function stderr() {
  const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
  return () => spy.mock.calls.map(([message]) => String(message)).join('');
}

// Windows cannot start a shell-script Git wrapper, so failure injection runs on Linux and macOS.
const itWithWrapper = it.skipIf(windows);

/** A git wrapper that fails the `at`-th and later runs of one subcommand. */
async function failingGit(root: string, command: string, at: number, message = `injected ${command} failure`) {
  const script = join(root, `git-fail-${command}`);
  const count = join(root, `count-${command}`);
  await rm(count, { force: true });
  await writeFile(
    script,
    `#!/bin/sh
for a in "$@"; do
  if [ "$a" = "${command}" ]; then
    n=$(cat "${count}" 2>/dev/null || echo 0); n=$((n+1)); echo $n > "${count}"
    if [ $n -ge ${at} ]; then echo "fatal: ${message}" >&2; exit 1; fi
  fi
done
exec "${realGit}" "$@"
`,
  );
  await chmod(script, 0o755);
  return script;
}

it('rejects malformed remotes as store keys', () => {
  for (const remote of [
    'not a url',
    'ftp://host/a/b',
    'https://host/only',
    'git@host:a/b c',
    'https://host/a//b',
    'git@ho$t:a/b',
  ])
    expect(keyForRemote(remote), remote).toBeUndefined();
});

it('falls back to plain Git for unsupported clone arguments', async () => {
  const root = await tmp();
  const written = stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, join(root, 'store')) });
  expect(await api.run(['clone', '-b'])).not.toBe(0);
  expect(await api.run(['clone', '--bogus=1', 'x'])).not.toBe(0);
  expect(await api.run(['clone'])).not.toBe(0);
  expect(await api.run(['clone', 'a', 'b', 'c'])).not.toBe(0);
  expect(written()).toContain('clone option -b requires a value');
  expect(written()).toContain('clone option --bogus is not supported');
  expect(written()).toContain('clone expects a repository and an optional directory');
});

it('accepts branch, recursive, and -- clone arguments', async () => {
  const { root, remote, store } = await fixture();
  stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', '--branch=main', '--recursive', '--quiet', '--', remote, 'one'])).toBe(0);
  expect(await api.run(['clone', '-b', 'main', '-q', remote, 'two'])).toBe(0);
  expect(git(['branch', '--show-current'], join(root, 'two'))).toBe('main');
  // A missing branch fails in Git after the pool was filled.
  expect(await api.run(['clone', '-b', 'nope', '-q', remote, 'three'])).not.toBe(0);
  await expect(stat(join(root, 'three'))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('falls back when the pool is unreachable or its lock cannot be taken', async () => {
  const { root, remote, store } = await fixture();
  const written = stderr();
  const dead = createGitDedup({ cwd: root, env: testEnv(root, join(root, 'dead-store')) });
  expect(await dead.run(['clone', 'git://127.0.0.1:1/team/project.git', 'x'])).not.toBe(0);
  expect(written()).toContain('object pool unavailable');
  await mkdir(store);
  await writeFile(join(store, '.gitx-store'), 'bogus\n');
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['clone', remote, 'plain'])).toBe(0);
  expect(written()).toContain('object pool lock unavailable');
  await expect(api.fetch()).rejects.toThrow('Invalid git-dedup store marker');
});

it('survives a throwing storage report callback', async () => {
  const { root, remote, store } = await fixture();
  const written = stderr();
  const api = createGitDedup({
    cwd: root,
    env: testEnv(root, store),
    onStorageReport: () => {
      throw new Error('boom');
    },
  });
  expect(await api.run(['clone', '-q', remote, 'c'])).toBe(0);
  expect(written()).toContain('storage report callback failed');
});

it('forwards unmanaged, prefixed, and environment-overridden invocations to plain Git', async () => {
  const { root, remote, store } = await fixture();
  const written = stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.run(['--version'])).toBe(0);
  expect(await api.run(['-C'])).not.toBe(0);
  expect(await api.run(['-ca.b=1', 'config', 'a.b'])).not.toBe(0);
  expect(await api.run(['--git-dir=nowhere', 'rev-parse', '--git-dir'])).not.toBe(0);
  expect(await api.run(['-c', 'a.b=1', 'clone', remote, 'prefixed'])).toBe(0);
  expect(written()).toContain('global option -c is not supported');
  expect(await api.run(['-C', root, 'clone', '-q', remote, 'nested'])).toBe(0);
  await expect(stat(join(root, 'nested', '.git', 'objects', 'info', 'alternates'))).resolves.toBeTruthy();
  const active = createGitDedup({ cwd: root, env: testEnv(root, store, { GIT_DEDUP_ACTIVE: '1' }) });
  expect(await active.run(['--version'])).toBe(0);
  const overridden = createGitDedup({ cwd: root, env: testEnv(root, store, { GIT_DIR: join(root, 'nowhere') }) });
  expect(await overridden.run(['worktree', 'add', 'x'])).not.toBe(0);
  expect(await overridden.run(['status'])).not.toBe(0);
  expect(written()).toContain('Git repository environment variables are set');
  expect(await overridden.add(root)).toMatchObject({ skipped: 1 });
  expect(await overridden.remove(root)).toMatchObject({ skipped: 1 });
});

it('reports a missing, invalid, or self-referencing Git executable', async () => {
  const root = await tmp();
  const empty = join(root, 'empty');
  const plain = join(root, 'plain');
  await mkdir(empty);
  await mkdir(plain);
  await writeFile(join(plain, 'git'), '#!/bin/sh\n');
  await chmod(join(plain, 'git'), 0o644);
  const store = join(root, 's');
  const noGit = createGitDedup({ cwd: root, env: testEnv(root, store, { PATH: `${empty}${delimiter}${plain}` }) });
  expect(await noGit.doctor()).toMatchObject({
    empty: true,
    checks: [{ name: 'git', ok: false, detail: 'Real Git executable not found on PATH' }],
  });
  const own = createGitDedup({ cwd: root, gitPath: nativeBinary, env: testEnv(root, store) });
  await expect(own.gitPath()).rejects.toThrow('must point to a real Git executable');
  const missing = createGitDedup({ cwd: root, gitPath: join(root, 'nope'), env: testEnv(root, store) });
  await expect(missing.gitPath()).rejects.toThrow('must point to a real Git executable');
  if (!windows) {
    const broken = join(root, 'broken-git');
    await writeFile(broken, '#!/bin/sh\necho nope >&2\nexit 3\n');
    await chmod(broken, 0o755);
    const failing = createGitDedup({ cwd: root, gitPath: broken, env: testEnv(root, store) });
    await expect(failing.gitVersion()).rejects.toThrow('git --version failed: nope');
  }
  const working = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await working.gitVersion()).toMatch(/^git version /);
});

it('honors a configured gitPath, including the legacy gitx key', async () => {
  const root = await tmp();
  // Windows runs only .exe files without a shell, so point at the real Git there.
  const fake = windows ? realGit : join(root, 'wrapped-git');
  if (!windows) {
    await writeFile(fake, `#!/bin/sh\nexec "${realGit}" "$@"\n`);
    await chmod(fake, 0o755);
  }
  for (const section of ['git-dedup', 'gitx']) {
    // Git config reads a backslash as an escape; forward slashes work on every platform.
    await writeFile(join(root, 'global.gitconfig'), `[${section}]\n gitPath = ${fake.replaceAll('\\', '/')}\n`);
    const api = createGitDedup({ cwd: root, env: testEnv(root, join(root, 's')) });
    expect(await api.gitPath()).toBe(fake);
  }
});

it('rejects an invalid pool in doctor, and invalid registrations in list and prune', async () => {
  const { root, remote, store } = await fixture();
  stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  await mkdir(join(store, 'pool.git'), { recursive: true });
  expect((await api.doctor()).checks[0]).toMatchObject({ name: 'pool', ok: false });
  await rm(store, { recursive: true });
  expect(await api.run(['clone', '-q', remote, 'consumer'])).toBe(0);
  expect(await api.doctor()).toMatchObject({
    checks: [
      { name: 'pool', ok: true },
      { name: 'git', ok: true },
    ],
  });
  const consumer = join(root, 'consumer');
  await writeFile(join(store, 'consumers', 'bad.json'), '{}\n');
  await expect(api.prune()).rejects.toThrow('Invalid git-dedup consumer registration: bad.json');
  await rm(join(store, 'consumers', 'bad.json'));
  // A consumer id that cannot be read for a reason other than absence.
  const idFile = join(consumer, '.git', 'gitx-consumer-id');
  const id = await readFile(idFile, 'utf8');
  await rm(idFile);
  await mkdir(idFile);
  // Node names the error EISDIR; Go reports the operating system's message.
  await expect(api.prune()).rejects.toThrow(/EISDIR|is a directory|Incorrect function/);
  await rm(idFile, { recursive: true });
  await writeFile(idFile, id);
  // An unreadable index and unsupported ref storage block pruning.
  await writeFile(join(consumer, '.git', 'index'), 'garbage');
  await expect(api.prune()).rejects.toThrow('cannot record the index');
  git(['read-tree', 'HEAD'], consumer);
  git(['config', 'core.repositoryformatversion', '1'], consumer);
  git(['config', 'extensions.refStorage', 'files'], consumer);
  await expect(api.prune()).rejects.toThrow('ref storage format');
  // Invalid remote registrations and an unreadable remotes directory.
  const remotes = join(store, 'remotes');
  await writeFile(join(remotes, 'bad.json'), '{"key":1}\n');
  await expect(api.listRemotes()).rejects.toThrow('Invalid git-dedup remote registration: bad.json');
  await rm(remotes, { recursive: true });
  await writeFile(remotes, 'not a directory');
  await expect(api.listRemotes()).rejects.toThrow(/remotes/);
});

it('prunes with an empty index tree and refreshes the lock heartbeat', async () => {
  const { root, remote, store } = await fixture();
  const local = join(root, 'local');
  git(['init', local], root);
  git(['remote', 'add', 'origin', remote], local);
  git(['read-tree', '--empty'], local);
  stderr();
  const realInterval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((fn: () => void) => {
    fn();
    return realInterval(() => {}, 1_000_000);
  }) as unknown as typeof setInterval);
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.add(local)).toMatchObject({ added: 1 });
  expect(await api.prune()).toMatchObject({});
});

it('skips unsupported or unkeyed repositories when adding', async () => {
  const { root, store } = await fixture();
  stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  const sha = join(root, 'sha');
  git(['init', '--object-format=sha256', sha], root);
  expect(await api.add(sha)).toMatchObject({
    repositories: [{ reason: 'unsupported object format (requires SHA-1)' }],
  });
  const local = join(root, 'local');
  git(['init', local], root);
  git(['remote', 'add', 'origin', '/some/local/path'], local);
  expect(await api.add(local)).toMatchObject({
    repositories: [{ reason: 'origin URL cannot be used as a store key' }],
  });
});

itWithWrapper('restores alternates when sharing objects fails during add', async () => {
  const { root, remote, store, source } = await fixture();
  stderr();
  for (const existing of [false, true]) {
    const consumer = join(root, existing ? 'with' : 'without');
    git(['clone', remote, consumer], root);
    const alternates = join(consumer, '.git', 'objects', 'info', 'alternates');
    const other = join(source, '.git', 'objects') + '\n';
    if (existing) {
      await mkdir(dirname(alternates), { recursive: true });
      await writeFile(alternates, other);
    }
    const gitPath = await failingGit(root, 'repack', 2);
    const api = createGitDedup({ cwd: root, gitPath, env: testEnv(root, store) });
    expect(await api.add(consumer)).toMatchObject({ failed: 1, repositories: [{ status: 'failed' }] });
    if (existing) expect(await readFile(alternates, 'utf8')).toBe(other);
    else await expect(stat(alternates)).rejects.toMatchObject({ code: 'ENOENT' });
  }
});

it('reports failed, skipped, and rolled-back removals', async () => {
  const { root, remote, store, source } = await fixture();
  stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.remove(join(root, 'missing'))).toMatchObject({
    failed: 1,
    repositories: [{ reason: expect.stringContaining('path not found') }],
  });
  const plain = join(root, 'plain');
  await mkdir(plain);
  expect(await api.remove(plain)).toMatchObject({ skipped: 1 });
  const consumer = join(root, 'consumer');
  expect(await api.run(['clone', '-q', remote, consumer])).toBe(0);
  const alternates = join(consumer, '.git', 'objects', 'info', 'alternates');
  const original = await readFile(alternates, 'utf8');
  // An fsck failure restores the alternate and reports the failure.
  if (!windows) {
    const gitPath = await failingGit(root, 'fsck', 1);
    const failing = createGitDedup({ cwd: root, gitPath, env: testEnv(root, store) });
    expect(await failing.remove(consumer)).toMatchObject({
      failed: 1,
      repositories: [{ reason: 'could not detach from the store' }],
    });
    expect(await readFile(alternates, 'utf8')).toBe(original);
  }
  // Rebase state names objects to keep; other alternates survive detaching.
  const head = git(['rev-parse', 'HEAD'], consumer);
  await mkdir(join(consumer, '.git', 'rebase-merge'));
  await writeFile(join(consumer, '.git', 'rebase-merge', 'onto'), head + '\n');
  const extra = join(source, '.git', 'objects');
  await writeFile(alternates, original + extra + '\n');
  expect(await api.remove(consumer)).toMatchObject({ removed: 1 });
  expect(await readFile(alternates, 'utf8')).toBe(extra + '\n');
  // A missing pool is reported.
  await writeFile(alternates, original);
  await rm(join(store, 'pool.git'), { recursive: true });
  expect(await api.remove(consumer)).toMatchObject({
    failed: 1,
    repositories: [{ detail: expect.stringContaining('pool is missing') }],
  });
});

it('forgets only registered checkouts that no longer exist', async () => {
  const { root, remote, store } = await fixture();
  stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.forget('anywhere')).toEqual([]);
  const consumer = join(root, 'consumer');
  expect(await api.run(['clone', '-q', remote, consumer])).toBe(0);
  await expect(api.forget(consumer)).rejects.toThrow('still exists');
});

it('falls back for unsupported submodule and worktree arguments', async () => {
  const { root, source, store } = await fixture();
  const written = stderr();
  const api = createGitDedup({ cwd: source, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update', '--checkout'])).toBe(0);
  expect(written()).toContain('submodule update --checkout is not supported');
  git(['config', 'submodule.active', 'other/*'], source);
  expect(await api.run(['submodule', 'update', '--init'])).toBe(0);
  expect(written()).toContain('submodule.active is configured');
  git(['config', '--unset-all', 'submodule.active'], source);
  expect(await api.run(['submodule', 'update', '--init', '--recursive'])).toBe(0);
  expect(await api.run(['submodule', 'status'])).toBe(0);
  expect(await api.run(['worktree', 'list'])).toBe(0);
  expect(await api.run(['worktree', 'add', '--bogus', '../wt0'])).not.toBe(0);
  expect(written()).toContain('worktree add --bogus is not supported');
  expect(await api.run(['worktree', 'add', '--', '../wt1'])).toBe(0);
  expect(await api.run(['worktree', 'add'])).not.toBe(0);
  expect(await api.run(['worktree', 'add', '--detach', '../wt2'])).toBe(0);
});

it('skips submodules that cannot or should not be seeded', async () => {
  const { root, store } = await fixture();
  const written = stderr();
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  const oid = '1111111111111111111111111111111111111111';
  const url = 'git://127.0.0.1:1/a/b.git';
  await writeFile(
    join(parent, '.gitmodules'),
    [
      `[submodule "urlonly"]\n\turl = ${url}`,
      `[submodule "a/../b"]\n\tpath = bad\n\turl = ${url}`,
      `[submodule "loose"]\n\tpath = loose\n\turl = ${url}`,
      '[submodule "local"]\n\tpath = local\n\turl = /nonexistent/local.git',
      '[submodule "gone"]\n\tpath = gone\n\turl = ./gone.git',
    ].join('\n') + '\n',
  );
  for (const path of ['local', 'gone']) git(['update-index', '--add', '--cacheinfo', `160000,${oid},${path}`], parent);
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store) });
  // Plain Git refuses what cannot be cloned; the seeding loop itself must not throw.
  expect(typeof (await api.run(['submodule', 'update', '--init', '--recursive']))).toBe('number');
  expect(written()).not.toContain('adoption unavailable');
  // Listings without a usable checkout, or without entries, are no-ops.
  await writeFile(join(parent, '.gitmodules'), `[submodule "x"]\n\tpath = missing/x\n\turl = ${url}\n`);
  await rm(join(parent, '.git', 'index'));
  expect(await api.run(['submodule', 'update', '--init', '--recursive'])).toBe(0);
  await writeFile(join(parent, '.gitmodules'), '');
  expect(await api.run(['submodule', 'update', '--init', '--recursive'])).toBe(0);
});

it('leaves inactive registered submodules to Git', async () => {
  const { root, store } = await fixture();
  const written = stderr();
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  await writeFile(join(parent, '.gitmodules'), '[submodule "off"]\n\tpath = off\n\turl = git://127.0.0.1:2/a/b.git\n');
  git(['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,off'], parent);
  git(['config', 'submodule.off.url', 'git://127.0.0.1:2/a/b.git'], parent);
  git(['config', 'submodule.off.active', 'false'], parent);
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'update'])).toBe(0);
  expect(written()).not.toContain('updating object pool');
});

it('reports submodule adoption failures and resolves scp-style relative URLs', async () => {
  const { root, store } = await fixture();
  const written = stderr();
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  git(['remote', 'add', 'origin', 'git@127.0.0.1:team/parent.git'], parent);
  await writeFile(join(parent, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n');
  git(['update-index', '--add', '--cacheinfo', '160000,1111111111111111111111111111111111111111,lib'], parent);
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store, { GIT_SSH_COMMAND: 'false' }) });
  expect(await api.run(['submodule', 'update', '--init', '--recursive'])).not.toBe(0);
  expect(written()).toContain('submodule adoption unavailable');
});

it('resolves relative submodule URLs that Git has not rewritten yet', async () => {
  const { root, store } = await fixture();
  const written = stderr();
  for (const [origin, expected] of [
    ['git@127.0.0.1:team/parent.git', 'adoption unavailable'],
    ['git://127.0.0.1:1/team/parent.git', 'adoption unavailable'],
    ['/some/local/parent.git', undefined],
  ] as const) {
    const parent = await mkdtemp(join(root, 'parent-'));
    git(['init'], parent);
    git(['remote', 'add', 'origin', origin], parent);
    await writeFile(join(parent, '.gitmodules'), '[submodule "lib"]\n\tpath = lib\n\turl = ../lib.git\n');
    git(['config', 'submodule.lib.url', '../lib.git'], parent);
    const api = createGitDedup({ cwd: parent, env: testEnv(root, store, { GIT_SSH_COMMAND: 'false' }) });
    await api.run(['submodule', 'update']);
    if (expected) expect(written()).toContain(expected);
  }
});

it('adds submodules named by a lone URL or after --', async () => {
  const { root, remote, store } = await fixture();
  stderr();
  const parent = join(root, 'parent');
  await mkdir(parent);
  git(['init'], parent);
  const api = createGitDedup({ cwd: parent, env: testEnv(root, store) });
  expect(await api.run(['submodule', 'add', remote])).toBe(0);
  expect(await api.run(['submodule', 'add', '--', remote, 'deps/project'])).toBe(0);
  await expect(stat(join(store, 'pool.git'))).resolves.toBeTruthy();
});

it('names the cause when the pool cannot be used during add', async () => {
  const { root, remote, store } = await fixture();
  stderr();
  const consumer = join(root, 'consumer');
  git(['clone', remote, consumer], root);
  await mkdir(store);
  await writeFile(join(store, '.gitx-store'), 'gitx-store-v2\n');
  git(['init', '--bare', '--object-format=sha256', join(store, 'pool.git')], root);
  const sha256 = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await sha256.add(consumer)).toMatchObject({ repositories: [{ reason: 'unsupported object format' }] });
  expect(await sha256.doctor()).toMatchObject({ checks: [{ name: 'pool', ok: false }, { name: 'git' }] });
  await rm(store, { recursive: true });
  if (windows) return;
  for (const [message, reason] of [
    ['cannot lock ref refs/gitx/x', 'ref collision in the shared pool'],
    ['could not resolve host: x', 'remote fetch failed'],
  ] as const) {
    const gitPath = await failingGit(root, 'fetch', 1, message);
    const api = createGitDedup({ cwd: root, gitPath, env: testEnv(root, store) });
    expect(await api.add(consumer)).toMatchObject({ repositories: [{ status: 'failed', reason }] });
  }
});

it('sorts registered remotes and reports unreachable ones on fetch', async () => {
  const { root, store } = await fixture();
  stderr();
  const api = createGitDedup({ cwd: root, env: testEnv(root, store) });
  expect(await api.gc()).toEqual({ compacted: false });
  await mkdir(join(store, 'remotes'), { recursive: true });
  await writeFile(join(store, '.gitx-store'), 'gitx-store-v2\n');
  for (const key of ['mmm/a/b', 'zzz/a/b', 'aaa/a/b', 'bbb/a/b'])
    await writeFile(
      join(store, 'remotes', `${createHash('sha256').update(key).digest('hex')}.json`),
      JSON.stringify({ key, remote: 'git://127.0.0.1:1/a/b.git' }) + '\n',
    );
  await writeFile(join(store, 'remotes', 'note.txt'), 'ignored');
  expect((await api.listRemotes()).map((entry) => entry.key)).toEqual(['aaa/a/b', 'bbb/a/b', 'mmm/a/b', 'zzz/a/b']);
  expect(await api.fetch()).toMatchObject({ fetched: 0, failed: 4 });
});
