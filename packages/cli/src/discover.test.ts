import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createGitDedup } from 'git-dedup-core';
import { afterEach, expect, it } from 'vitest';
import { discoverCheckouts } from './discover.js';

const windows = process.platform === 'win32';
const realGit = execFileSync(windows ? 'where' : 'which', ['git'], { encoding: 'utf8' })
  .split(/\r?\n/)[0]!
  .trim();
const fixtures: string[] = [];

async function fixture(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'git-dedup-discover-'));
  fixtures.push(path);
  return path;
}

function init(path: string): void {
  execFileSync('git', ['init', '-q', path]);
}

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

it('finds checkouts in ordinary directories outside a Git worktree', async () => {
  const root = await fixture();
  const vendor = join(root, 'vendor', 'project');
  const build = join(root, 'build', 'project');
  await mkdir(join(root, 'vendor'), { recursive: true });
  await mkdir(join(root, 'build'), { recursive: true });
  init(vendor);
  init(build);
  // Windows creates directory junctions without privileges; other platforms ignore the type.
  await symlink(root, join(root, 'cycle'), 'junction');

  expect((await discoverCheckouts(root)).map(({ path }) => path)).toEqual([build, vendor]);
});

it('honors nested ignore rules and negation without traversing ignored parents', async () => {
  const root = await fixture();
  init(root);
  await writeFile(join(root, '.gitignore'), 'ignored/\n*.hidden/\n!kept.hidden/\n');
  const paths = {
    build: join(root, 'build', 'project'),
    ignored: join(root, 'ignored', 'project'),
    kept: join(root, 'kept.hidden', 'project'),
    blocked: join(root, 'nested', 'blocked', 'project'),
    visible: join(root, 'nested', 'visible', 'project'),
  };
  await mkdir(join(root, 'nested'), { recursive: true });
  await writeFile(join(root, 'nested', '.gitignore'), 'blocked/\n');
  for (const path of Object.values(paths)) init(path);
  await symlink(root, join(root, 'cycle'), 'junction');

  expect((await discoverCheckouts(root)).map(({ path }) => path)).toEqual([
    root,
    paths.build,
    paths.kept,
    paths.visible,
  ]);
});

// Windows cannot start a shell-script Git wrapper; Linux and macOS cover this.
it.skipIf(windows)('rejects when git check-ignore fails and when the target is not a directory', async () => {
  const root = await fixture();
  init(root);
  await mkdir(join(root, 'child'));
  const wrapper = join(root, 'failing-git');
  await writeFile(
    wrapper,
    `#!/bin/sh\ncase "$*" in *check-ignore*) echo broken >&2; exit 128;; esac\nexec '${realGit}' "$@"\n`,
    { mode: 0o755 },
  );
  await expect(discoverCheckouts(root, wrapper)).rejects.toThrow('git check-ignore failed: broken');
  await writeFile(join(root, 'file'), '');
  await expect(discoverCheckouts(join(root, 'file'))).rejects.toThrow('Not a directory');
});

it('uses the Git executable configured with git-dedup.gitPath', async () => {
  const root = await fixture();
  const project = join(root, 'project');
  init(project);
  const log = join(root, 'calls.log');
  // Windows runs only .exe files without a shell, so configure the real Git there.
  const wrapper = windows ? realGit : join(root, 'configured-git');
  if (!windows) await writeFile(wrapper, `#!/bin/sh\necho "$@" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
  // Git config reads a backslash as an escape; forward slashes work on every platform.
  await writeFile(join(root, 'config'), `[git-dedup]\n gitPath = ${wrapper.replaceAll('\\', '/')}\n`);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'config'), GIT_CONFIG_NOSYSTEM: '1' };
  const git = await createGitDedup({ cwd: root, env }).gitPath();

  expect(git).toBe(wrapper);
  expect((await discoverCheckouts(root, git)).map(({ path }) => path)).toEqual([project]);
  if (!windows) expect(await readFile(log, 'utf8')).toContain('rev-parse --absolute-git-dir');
});

it('skips stale worktree .git files and still finds valid checkouts', async () => {
  const root = await fixture();
  const valid = join(root, 'valid');
  init(valid);
  await mkdir(join(root, 'stale', 'child'), { recursive: true });
  await writeFile(join(root, 'stale', '.git'), 'gitdir: /definitely/missing/gitdir\n');
  await mkdir(join(valid, 'inner', 'stale2'), { recursive: true });
  await writeFile(join(valid, 'inner', 'stale2', '.git'), 'gitdir: /definitely/missing/gitdir\n');

  expect((await discoverCheckouts(root)).map(({ path }) => path)).toEqual([valid]);
});
