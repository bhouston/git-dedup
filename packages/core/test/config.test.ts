import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitx } from '../src/index.js';

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
    GITX_STORE: store,
    GITX_ACTIVE: undefined,
    GITX_DISABLE: undefined,
  };
  return { root, config, store, env, api: createGitx({ cwd: root, env }) };
}

it('uses only the default or environment store and ignores Git store configuration', async () => {
  const { root, config, store, env, api } = await fixture();
  vi.stubEnv('HOME', root);
  await writeFile(config, `[gitx]\n store = ${join(root, 'legacy')}\n`);
  const before = await readFile(config, 'utf8');
  expect(await api.storePath()).toBe(store);
  const defaults = createGitx({ cwd: root, env: { ...env, GITX_STORE: undefined } });
  expect(await defaults.storePath()).toBe(join(root, '.cache', 'gitx'));
  const relative = createGitx({ cwd: root, env: { ...env, GITX_STORE: 'custom-store' } });
  expect(await relative.storePath()).toBe(join(root, 'custom-store'));
  expect(await readFile(config, 'utf8')).toBe(before);
});

it('doctor reports checks and never changes global Git configuration', async () => {
  const { config, api } = await fixture();
  await writeFile(config, '[user]\n name = Test\n');
  const before = await readFile(config, 'utf8');
  const result = await api.doctor();
  expect(result.checks.map((check) => check.name)).toEqual(['filesystem', 'reflink', 'git']);
  expect(await readFile(config, 'utf8')).toBe(before);
});

it('uses gitx.gitPath from Git configuration', async () => {
  const { config, env, root } = await fixture();
  const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(config, `[gitx]\n gitPath = ${binary}\n`);
  const api = createGitx({ cwd: root, env });
  expect((await api.doctor()).checks.find((check) => check.name === 'git')?.detail).toContain(binary);
});
