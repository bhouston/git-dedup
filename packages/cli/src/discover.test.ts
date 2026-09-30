import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { discoverCheckouts } from './discover.js';

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
  await symlink(root, join(root, 'cycle'));

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
  await symlink(root, join(root, 'cycle'));

  expect((await discoverCheckouts(root)).map(({ path }) => path)).toEqual([
    root,
    paths.build,
    paths.kept,
    paths.visible,
  ]);
});
