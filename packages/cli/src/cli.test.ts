import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { commandLine, extendMatchers } from 'vitest-command-line';

extendMatchers();

const bin = new URL('../dist/bin.js', import.meta.url).pathname;
const cli = commandLine({ command: ['node', bin], name: 'gitx' });
const dirs: string[] = [];
const daemons: ChildProcess[] = [];

async function fixture(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'gitx-cli-'));
  dirs.push(dir);
  return dir;
}

function isolatedEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_GLOBAL: join(dir, 'global.gitconfig'),
    GIT_CONFIG_SYSTEM: join(dir, 'system.gitconfig'),
    GITX_STORE: join(dir, 'store'),
    GITX_DISABLE: '0',
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

describe('gitx CLI', () => {
  it('shows its commands and version', async () => {
    const help = await cli.run(['--help']);
    expect(help).toSucceed();
    expect(help).toHaveStdout(/cache/);
    expect(help).toHaveStdout(/store/);

    const version = await cli.run(['--version']);
    expect(version).toSucceed();
    // Editors that use gitx as git.path read the leading Git version.
    expect(version).toHaveStdout(/^git version \d+\.\d+\S* .*\(gitx 0\.1\.0\)\n?$/);
  });

  it('generates the OpenCLI document', async () => {
    const result = await cli.run(['docgen']);
    expect(result).toSucceed();
    const doc = result.json<{
      info: { title: string };
      global: { flags: Array<{ name: string }> };
      commands: Record<string, unknown>;
    }>();
    expect(doc.info.title).toBe('gitx');
    expect(doc.global.flags).toContainEqual(expect.objectContaining({ name: 'stats' }));
    expect(doc.commands).toHaveProperty('gitx clone');
    expect(doc.commands).toHaveProperty('gitx store');
    expect(doc.commands).toHaveProperty('gitx store fetch');
    expect(doc.commands).not.toHaveProperty('gitx store refresh');
    expect(doc.commands).toHaveProperty('gitx store gc');
    expect(doc.commands).not.toHaveProperty('gitx store clear');
    expect(doc.commands).not.toHaveProperty('gitx store set');
  });

  it('generates documentation for nested store commands', async () => {
    const result = await cli.run(['docgen', '--format', 'markdown']);
    expect(result).toSucceed();
    expect(result).toHaveStdout('## gitx store fetch');
    expect(result).toHaveStdout('## gitx store gc');
    expect(result).not.toHaveStdout('## gitx store set');
  });

  it('fetches store mirrors and rejects the removed refresh command', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir) };
    expect(await cli.run(['clone', remote, 'consumer'], options)).toSucceed();
    const result = await cli.run(['store', 'fetch'], options);
    expect(result).toSucceed();
    expect(result).toHaveStdout('Fetched 1 mirror(s).');
    expect(await cli.run(['store', 'refresh'], options)).toFail();
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
    expect(result).toHaveStdout('Mirrors: 0');
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

  it('bypasses the store when disabled', async () => {
    const dir = await fixture();
    const env = { ...isolatedEnv(dir), GITX_DISABLE: '1' };
    const result = await cli.run(['clone', 'https://127.0.0.1:1/example/repo.git', join(dir, 'checkout')], {
      env,
      timeout: 5_000,
    });
    expect(result).toFail();
    expect(result.exitCode).toBe(128);
    await expect(access(env.GITX_STORE!)).rejects.toThrow();
  });

  it('reports clone and cache storage estimates only when requested', async () => {
    const { dir, remote } = await gitRemoteFixture();
    const options = { cwd: dir, env: isolatedEnv(dir), timeout: 10_000 };
    const first = await cli.run(['--stats', 'clone', remote, 'first'], options);
    expect(first).toSucceed();
    expect(first).toHaveStderr(/created mirror/);
    expect(first).toHaveStderr(/estimated duplicate pack bytes avoided .* bytes/);

    const second = await cli.run(['--stats', 'clone', remote, 'second'], options);
    expect(second).toSucceed();
    expect(second).toHaveStderr(/reused mirror/);

    const plain = await cli.run(['clone', remote, 'plain'], options);
    expect(plain).toSucceed();
    expect(plain.stderr).not.toContain('estimated duplicate pack bytes avoided');

    const native = await commandLine({ command: ['git'], name: 'git' }).run(['clone', remote, 'adopt'], options);
    expect(native).toSucceed();
    const cache = await cli.run(['cache', 'adopt', '--stats'], options);
    expect(cache).toSucceed();
    expect(cache).toHaveStdout(/Cached 1 repository/);
    expect(cache).toHaveStderr(/private packs .* -> .*/);
    expect(cache).toHaveStderr(/estimated private pack reduction .* bytes/);
  });
});
