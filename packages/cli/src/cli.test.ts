import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { validate } from '@clidoc/core';
import { afterEach, describe, expect, it } from 'vitest';
import { commandLine, extendMatchers } from 'vitest-command-line';

extendMatchers();

const bin = new URL('../dist/bin.js', import.meta.url).pathname;
const cli = commandLine({ command: ['node', bin], name: 'git-dedup' });
const dirs: string[] = [];
const daemons: ChildProcess[] = [];

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'git-dedup-cli-'));
  dirs.push(dir);
  return dir;
}

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(dir, 'global.gitconfig'),
    GIT_CONFIG_SYSTEM: join(dir, 'system.gitconfig'),
    GIT_DEDUP_STORE: join(dir, 'store'),
  };
}

afterEach(async () => {
  for (const daemon of daemons.splice(0)) daemon.kill();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function gitRemoteFixture(): Promise<{ dir: string; remote: string }> {
  const dir = await fixture();
  const remotes = join(dir, 'remotes');
  const remote = join(remotes, 'team', 'project.git');
  const source = join(dir, 'source');
  await mkdir(join(remotes, 'team'), { recursive: true });
  const env = isolatedEnv(dir);
  const git = (args: string[]) => execFileSync('git', args, { env, stdio: 'pipe' });
  git(['init', '-q', '--bare', '--initial-branch=main', remote]);
  git(['init', '-q', '--initial-branch=main', source]);
  git([
    '-C',
    source,
    '-c',
    'user.name=Gitx Test',
    '-c',
    'user.email=test@example.invalid',
    'commit',
    '-q',
    '--allow-empty',
    '-m',
    'initial',
  ]);
  git(['-C', source, 'remote', 'add', 'origin', remote]);
  git(['-C', source, 'push', '-q', 'origin', 'main']);
  const port = await new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() => resolve(typeof address === 'object' && address ? address.port : 0));
    });
  });
  const daemon = spawn(
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
  daemons.push(daemon);
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Git daemon did not start')), 10_000);
    daemon.once('error', reject);
    daemon.once('exit', (code) => reject(new Error(`Git daemon exited: ${code}`)));
    daemon.stderr?.on('data', (chunk) => {
      if (String(chunk).includes('Ready to rumble')) {
        clearTimeout(timeout);
        resolve();
      }
    });
  });
  return { dir, remote: `git://127.0.0.1:${port}/team/project.git` };
}

describe('git-dedup CLI', () => {
  it('shows its commands and version', async () => {
    const help = await cli.run(['--help']);
    expect(help).toSucceed();
    expect(help).toHaveStdout(/store/);
    expect(help).not.toHaveStdout(/cache/);

    const version = await cli.run(['--version']);
    expect(version).toSucceed();
    // Editors that use git-dedup as git.path read the leading Git version.
    expect(version).toHaveStdout(/^git version \d+\.\d+\S* .*\(git-dedup 0\.1\.0\)\n?$/);
  });

  it('generates the OpenCLI document', async () => {
    const result = await cli.run(['docgen']);
    expect(result).toSucceed();
    const doc = result.json<{
      info: { title: string };
      global: { flags: Array<{ name: string }> };
      commands: Record<string, unknown>;
    }>();
    expect(validate(doc)).toMatchObject({ valid: true });
    expect(doc.info.title).toBe('git-dedup');
    expect(doc.global.flags).toContainEqual(expect.objectContaining({ name: 'stats' }));
    expect(doc.commands).toHaveProperty('git-dedup clone');
    expect(doc.commands).toHaveProperty('git-dedup store');
    expect(doc.commands).toHaveProperty('git-dedup store add');
    expect(doc.commands).not.toHaveProperty('git-dedup cache');
    expect(doc.commands).not.toHaveProperty('git-dedup doctor');
    expect(doc.commands).toHaveProperty('git-dedup store fetch');
    expect(doc.commands).toHaveProperty('git-dedup store list');
    expect(doc.commands).not.toHaveProperty('git-dedup store refresh');
    expect(doc.commands).toHaveProperty('git-dedup store gc');
    expect(doc.commands).toHaveProperty('git-dedup store remove');
    expect(doc.commands).toHaveProperty('git-dedup store prune');
    expect(doc.commands).not.toHaveProperty('git-dedup store clear');
    expect(doc.commands).not.toHaveProperty('git-dedup store set');
  });

  it('generates documentation for nested store commands', async () => {
    const result = await cli.run(['docgen', '--format', 'markdown']);
    expect(result).toSucceed();
    expect(result).toHaveStdout('## git-dedup store add');
    expect(result).toHaveStdout('## git-dedup store fetch');
    expect(result).toHaveStdout('## git-dedup store list');
    expect(result).toHaveStdout('## git-dedup store gc');
    expect(result).not.toHaveStdout('## git-dedup store set');
  });

  it('fetches registered remotes and rejects the removed refresh command', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    expect(await cli.run(['clone', remote, 'consumer'], options)).toSucceed();
    const result = await cli.run(['store', 'fetch'], options);
    expect(result).toSucceed();
    expect(result).toHaveStdout('Fetched 1 remote(s); 0 failed.');
    await rm(join(dir, 'remotes', 'team', 'project.git'), { recursive: true, force: true });
    const failed = await cli.run(['store', 'fetch'], options);
    expect(failed).toFail();
    expect(failed).toHaveStdout('Fetched 0 remote(s); 1 failed.');
    expect(await cli.run(['store', 'refresh'], options)).toFail();
  });

  it('removes a clone from the store and then reports a no-op', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    expect(await cli.run(['clone', remote, 'consumer'], options)).toSucceed();
    const removed = await cli.run(['store', 'remove', 'consumer'], options);
    expect(removed).toSucceed();
    expect(removed).toHaveStdout(/Removed .*consumer: objects now use \d/);
    const again = await cli.run(['store', 'remove', 'consumer'], options);
    expect(again).toSucceed();
    expect(again).toHaveStdout('Nothing to remove: consumer is not linked to the store.');
  });

  it('prunes only after a deleted checkout is forgotten', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    expect(await cli.run(['clone', remote, 'consumer'], options)).toSucceed();
    expect(await cli.run(['clone', remote, 'deleted'], options)).toSucceed();
    await rm(join(dir, 'deleted'), { recursive: true, force: true });
    const refused = await cli.run(['store', 'prune'], options);
    expect(refused).toFail();
    expect(refused).toHaveStderr(/If it was deleted, run git-dedup store remove --forget <old path>/);
    const removed = await cli.run(['store', 'remove', 'deleted'], options);
    expect(removed).toFail();
    expect(removed).toHaveStderr(/run git-dedup store remove --forget/);
    const forgotten = await cli.run(['store', 'remove', '--forget', 'deleted'], options);
    expect(forgotten).toSucceed();
    expect(forgotten).toHaveStdout(/Forgot .*deleted\/\.git/);
    const result = await cli.run(['store', 'prune'], options);
    expect(result).toSucceed();
    expect(result).toHaveStdout(/Reclaimed \d/);
  });

  it.each([['clear'], ['set', 'new-store']])('rejects removed store command %s', async (...args) => {
    const dir = await fixture();
    const env = isolatedEnv(dir);
    const result = await cli.run(['store', ...args], { cwd: dir, env });
    expect(result).toFail();
    await expect(access(env.GIT_CONFIG_GLOBAL!)).rejects.toThrow();
    await expect(access(join(dir, 'new-store'))).rejects.toThrow();
  });

  it('runs the default store command from its directory', async () => {
    const dir = await fixture();
    const result = await cli.run(['store'], { env: isolatedEnv(dir) });
    expect(result).toSucceed();
    expect(result).toHaveStdout(join(dir, 'store'));
    expect(result).toHaveStdout('Remotes: 0');
    expect(result).toHaveStdout('Size: 0B');
    expect(result).toHaveStdout(
      'The store is empty. Start with `git-dedup clone <url>` or `git-dedup store add [path]`.',
    );
    expect(result).not.toHaveStdout(/WARN/);
    expect(result).toHaveStdout(/OK git: .*git version/);
    await expect(access(join(dir, 'store'))).rejects.toThrow();

    await mkdir(join(dir, 'store', 'pool.git'), { recursive: true });
    const invalid = await cli.run(['store'], { env: isolatedEnv(dir) });
    expect(invalid).toFail();
    expect(invalid).toHaveStdout(/WARN pool: /);
    expect(invalid).not.toHaveStdout(/store is empty/);
  });

  it('shows passing store health after cloning a remote', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    expect(await cli.run(['clone', remote, 'consumer'], options)).toSucceed();
    const result = await cli.run(['store'], options);
    expect(result).toSucceed();
    expect(result).toHaveStdout('Remotes: 1');
    expect(result).toHaveStdout(/OK pool: .*SHA-1 bare object database/);
    expect(result).toHaveStdout(/OK git: .*git version/);
  });

  it('lists registered remotes and reports an empty store', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    const empty = await cli.run(['store', 'list'], options);
    expect(empty).toSucceed();
    expect(empty).toHaveStdout('No remotes registered.');
    await expect(access(join(dir, 'store'))).rejects.toThrow();

    expect(await cli.run(['clone', remote, 'consumer'], options)).toSucceed();
    const listed = await cli.run(['store', 'list'], options);
    expect(listed).toSucceed();
    expect(listed).toHaveStdout('KEY\tFETCH URL');
    expect(listed).toHaveStdout(remote);
  });

  it('preserves raw Git options during passthrough', async () => {
    const dir = await fixture();
    execFileSync('git', ['init', '-q', dir]);
    const result = await cli.run(['-C', dir, '-c', 'user.name=Gitx Test', 'config', 'user.name'], {
      env: isolatedEnv(dir),
    });
    expect(result).toSucceed();
    expect(result).toHaveStdout('Gitx Test\n');
  });

  it('returns native Git exit codes', async () => {
    const dir = await fixture();
    execFileSync('git', ['init', '-q', dir]);
    const args = ['-C', dir, 'rev-parse', '--verify', 'missing-ref'];
    const native = await commandLine({ command: ['git'], name: 'git' }).run(args, { env: isolatedEnv(dir) });
    const wrapped = await cli.run(args, { env: isolatedEnv(dir) });
    expect(wrapped).toFail();
    expect(wrapped.exitCode).toBe(native.exitCode);
    expect(wrapped.stderr).toBe(native.stderr);
  });

  it('rejects the retired cache command', async () => {
    const dir = await fixture();
    const result = await cli.run(['cache', dir], { cwd: dir, env: isolatedEnv(dir) });
    expect(result).toFail();
    expect(result).not.toHaveStdout(/Added /);
  });

  it('reports clone and adoption storage estimates only when requested', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir), timeout: 10_000 };
    const first = await cli.run(['--stats', 'clone', remote, 'first'], options);
    expect(first).toSucceed();
    expect(first).toHaveStderr(/created object pool/);
    expect(first).toHaveStderr(/objects borrowed through Git alternates/);

    const second = await cli.run(['--stats', 'clone', remote, 'second'], options);
    expect(second).toSucceed();
    expect(second).toHaveStderr(/reused object pool/);

    const plain = await cli.run(['clone', remote, 'plain'], options);
    expect(plain).toSucceed();
    expect(plain.stderr).not.toContain('objects borrowed through Git alternates');

    const native = await commandLine({ command: ['git'], name: 'git' }).run(['clone', remote, 'adopt'], options);
    expect(native).toSucceed();
    const adoption = await cli.run(['store', 'add', 'adopt', '--stats'], options);
    expect(adoption).toSucceed();
    expect(adoption).toHaveStdout(/Added 1 repository/);
    expect(adoption).toHaveStderr(/private packs .* -> .*/);
    expect(adoption).toHaveStderr(/estimated private pack reduction [\d.]+[kMGT]?B; logical pack bytes only/);
  });

  it('stays silent with -q like plain Git', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir), timeout: 20_000 };
    const git = (args: string[]) => execFileSync('git', args, { env: options.env, stdio: 'pipe' });
    const work = join(dir, 'super-work');
    const bare = join(dir, 'remotes', 'team', 'super.git');
    git(['init', '-q', '--bare', '--initial-branch=main', bare]);
    git(['clone', '-q', remote, work]);
    git(['-C', work, 'submodule', 'add', '-q', remote, 'modules/child']);
    git(['-C', work, '-c', 'user.name=Gitx Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'sub']);
    git(['-C', work, 'push', '-q', bare, 'HEAD:main']);
    const quiet = (result: { stdout: string; stderr: string }) => {
      expect(result).toSucceed();
      expect(result.stdout).toBe('');
      expect(result.stderr).toBe('');
    };
    quiet(await cli.run(['clone', '-q', '--recurse-submodules', remote.replace('project.git', 'super.git')], options));
    quiet(await cli.run(['-C', 'super', 'worktree', 'add', '-q', '-b', 'review', '../review'], options));
    quiet(await cli.run(['-C', 'super', 'submodule', 'add', '-q', remote, 'modules/other'], options));
  });

  it('previews and adds discovered checkouts, including nested repositories and submodules', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const env = isolatedEnv(dir);
    const git = (args: string[]) => execFileSync('git', args, { env, stdio: 'pipe' });
    const workspace = join(dir, 'workspace');
    await mkdir(workspace);
    const parent = join(workspace, 'parent');
    const nested = join(parent, 'nested', 'independent');
    const submodule = join(parent, 'modules', 'child');
    const worktree = join(workspace, 'parent-worktree');
    git(['clone', '-q', remote, parent]);
    git(['-C', parent, 'submodule', 'add', '-q', remote, 'modules/child']);
    git([
      '-C',
      parent,
      '-c',
      'user.name=Gitx Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-qam',
      'submodule',
    ]);
    await mkdir(join(parent, 'nested'), { recursive: true });
    git(['clone', '-q', remote, nested]);
    git(['-C', parent, 'worktree', 'add', '-qb', 'review', worktree]);
    const failing = join(workspace, 'broken');
    git(['init', '-q', failing]);
    git(['-C', failing, 'remote', 'add', 'origin', 'git://127.0.0.1:1/team/missing.git']);
    git([
      '-C',
      failing,
      '-c',
      'user.name=Gitx Test',
      '-c',
      'user.email=test@example.invalid',
      'commit',
      '-q',
      '--allow-empty',
      '-m',
      'lost',
    ]);
    // A ref to a missing commit makes adoption fail.
    const lost = execFileSync('git', ['-C', failing, 'rev-parse', 'HEAD'], { env }).toString().trim();
    await rm(join(failing, '.git', 'objects', lost.slice(0, 2), lost.slice(2)));
    const options = { cwd: dir, env, timeout: 30_000 };

    const preview = await cli.run(['store', 'add', workspace, '--all', '--dry-run'], options);
    expect(preview).toSucceed();
    expect(preview).toHaveStdout(/Discovered 4 checkout\(s\)/);
    expect(preview.stdout).toContain(parent);
    expect(preview.stdout).toContain(nested);
    expect(preview.stdout).toContain(submodule);
    expect(preview.stdout).toContain(failing);
    expect(preview.stdout).not.toContain(worktree);
    await expect(access(join(dir, 'store'))).rejects.toThrow();

    const run = await cli.run(['store', 'add', workspace, '--all'], options);
    expect(run).toFail();
    expect(run).toHaveStdout(/Added 3 repository\(s\); skipped 0; failed 1\./);
    expect(run).toHaveStdout(new RegExp(`Finished ${nested}`));
    expect(run).toHaveStderr(new RegExp(`Failed ${failing}`));
    expect(run).toHaveStdout(new RegExp(`Skipped ${submodule}: handled with`));
  });

  it('reports an empty directory without creating a store', async () => {
    const dir = await fixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    const result = await cli.run(['store', 'add', dir, '--all'], options);
    expect(result).toSucceed();
    expect(result).toHaveStdout(/Discovered 0 checkout\(s\)/);
    expect(result).toHaveStdout(/Added 0 repository\(s\); skipped 0; failed 0\./);
    await expect(access(join(dir, 'store'))).rejects.toThrow();
  });

  it('names skipped and failed adoption paths with bounded output and verbose details', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir), timeout: 10_000 };
    const missing = await cli.run(['store', 'add', 'missing'], options);
    expect(missing).toSucceed();
    expect(missing).toHaveStderr(/Skipped .*missing: not a Git repository or path is unavailable/);
    expect(missing).toHaveStdout('Added 0 repository(s); skipped 1; failed 0.');

    const native = await commandLine({ command: ['git'], name: 'git' }).run(['clone', remote, 'consumer'], options);
    expect(native).toSucceed();
    const badStoreOptions = { ...options, env: { ...options.env, GIT_DEDUP_STORE: join(dir, 'source') } };
    const failed = await cli.run(['store', 'add', 'consumer'], badStoreOptions);
    expect(failed).toFail();
    expect(failed).toHaveStderr(/Failed .*consumer: Git storage operation failed/);
    expect(failed).toHaveStdout('Added 0 repository(s); skipped 0; failed 1.');
    expect(failed.stderr).not.toContain('git -C');
    const verbose = await cli.run(['store', 'add', 'consumer', '--verbose'], badStoreOptions);
    expect(verbose).toFail();
    expect(verbose.stderr).toContain('Refusing to adopt a nonempty directory');
  });
});
