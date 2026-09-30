import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitDedup } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'gitx-config-')));
  roots.push(root);
  const config = join(root, 'config');
  const store = join(root, 'store');
  const env = {
    ...process.env,
    GIT_CONFIG_GLOBAL: config,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_DEDUP_STORE: store,
    GITX_STORE: undefined,
    GIT_DEDUP_ACTIVE: undefined,
    GITX_ACTIVE: undefined,
  };
  return { root, config, store, env, api: createGitDedup({ cwd: root, env }) };
}

it('uses the new default, preserves legacy stores, and respects explicit overrides', async () => {
  const { root, config, store, env, api } = await fixture();
  vi.stubEnv('HOME', root);
  await writeFile(config, `[gitx]\n store = ${join(root, 'legacy')}\n`);
  const before = await readFile(config, 'utf8');
  expect(await api.storePath()).toBe(store);
  const defaults = createGitDedup({ cwd: root, env: { ...env, GIT_DEDUP_STORE: undefined } });
  expect(await defaults.storePath()).toBe(join(root, '.git-dedup'));
  await mkdir(join(root, '.gitx'));
  expect(await defaults.storePath()).toBe(join(root, '.gitx'));
  await mkdir(join(root, '.cache', 'gitx'), { recursive: true });
  expect(await defaults.storePath()).toBe(join(root, '.cache', 'gitx'));
  const relative = createGitDedup({ cwd: root, env: { ...env, GIT_DEDUP_STORE: 'custom-store' } });
  expect(await relative.storePath()).toBe(join(root, 'custom-store'));
  const oldOverride = createGitDedup({
    cwd: root,
    env: { ...env, GIT_DEDUP_STORE: undefined, GITX_STORE: 'old-store' },
  });
  expect(await oldOverride.storePath()).toBe(join(root, 'old-store'));
  const newWins = createGitDedup({ cwd: root, env: { ...env, GIT_DEDUP_STORE: 'new-store', GITX_STORE: 'old-store' } });
  expect(await newWins.storePath()).toBe(join(root, 'new-store'));
  expect(await readFile(config, 'utf8')).toBe(before);
});

it('doctor reports checks and never changes global Git configuration', async () => {
  const { config, api } = await fixture();
  await writeFile(config, '[user]\n name = Test\n');
  const before = await readFile(config, 'utf8');
  const result = await api.doctor();
  expect(result.checks.map((check) => check.name)).toEqual(['pool', 'git']);
  expect(await readFile(config, 'utf8')).toBe(before);
});

it('uses git-dedup.gitPath from Git configuration and accepts the old setting', async () => {
  const { config, env, root } = await fixture();
  const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(config, `[git-dedup]\n gitPath = ${binary}\n`);
  const api = createGitDedup({ cwd: root, env });
  expect((await api.doctor()).checks.find((check) => check.name === 'git')?.detail).toContain(binary);
  await writeFile(config, `[gitx]\n gitPath = ${binary}\n`);
  expect(
    (await createGitDedup({ cwd: root, env }).doctor()).checks.find((check) => check.name === 'git')?.detail,
  ).toContain(binary);
});
