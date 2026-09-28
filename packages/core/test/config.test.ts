import { afterEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createGitx } from '../src/index.js';

const roots: string[] = [];
afterEach(async () => {
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

it('writes only explicitly requested global configuration and honors environment store precedence', async () => {
  const { root, config, store, env, api } = await fixture();
  const configured = join(root, 'configured');
  expect(await api.setStore(configured)).toBe(configured);
  const text = await readFile(config, 'utf8');
  expect(text).toContain(configured);
  expect(text).toContain(join(configured, 'lfs'));
  expect((await api.storeInfo()).path).toBe(store);
  const fromConfig = createGitx({ cwd: root, env: { ...env, GITX_STORE: undefined } });
  expect((await fromConfig.storeInfo()).path).toBe(configured);
  await fromConfig.clear();
});

it('refuses to clear an unrelated directory, even one with a mirrors subdirectory', async () => {
  const { store, api } = await fixture();
  await mkdir(join(store, 'mirrors'), { recursive: true });
  await writeFile(join(store, 'precious.txt'), 'keep');
  await expect(api.clear()).rejects.toThrow('unrecognized store');
  expect(await readFile(join(store, 'precious.txt'), 'utf8')).toBe('keep');
});

it('refuses to clear a managed store after unrelated files have been added', async () => {
  const { store, api } = await fixture();
  await api.setStore(store);
  await writeFile(join(store, 'precious.txt'), 'keep');
  await expect(api.clear()).rejects.toThrow('unrelated files');
  expect(await readFile(join(store, 'precious.txt'), 'utf8')).toBe('keep');
});

it('doctor reports checks and never changes global Git configuration', async () => {
  const { config, api } = await fixture();
  await writeFile(config, '[user]\n name = Test\n');
  const before = await readFile(config, 'utf8');
  const result = await api.doctor();
  expect(result.checks.map((check) => check.name)).toEqual(['filesystem', 'reflink', 'git', 'lfs.storage']);
  expect(await readFile(config, 'utf8')).toBe(before);
  await api.clear();
});

it('uses gitx.gitPath from Git configuration', async () => {
  const { config, env, root } = await fixture();
  const binary = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  await writeFile(config, `[gitx]\n gitPath = ${binary}\n`);
  const api = createGitx({ cwd: root, env });
  expect((await api.doctor()).checks.find((check) => check.name === 'git')?.detail).toContain(binary);
});
