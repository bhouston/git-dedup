import { afterEach, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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
  // homedir() reads USERPROFILE on Windows.
  vi.stubEnv('USERPROFILE', root);
  await writeFile(config, `[gitx]\n store = ${join(root, 'legacy')}\n`);
  const before = await readFile(config, 'utf8');
  expect(await api.storePath()).toBe(store);
  const defaults = createGitDedup({ cwd: root, env: { ...env, GIT_DEDUP_STORE: undefined } });
  expect(await defaults.storePath()).toBe(join(root, '.git-dedup'));
  await mkdir(join(root, '.gitx'));
  await writeFile(join(root, '.gitx', 'unrelated'), 'not a store\n');
  expect(await defaults.storePath()).toBe(join(root, '.git-dedup'));
  await writeFile(join(root, '.gitx', '.gitx-store'), 'something else\n');
  expect(await defaults.storePath()).toBe(join(root, '.git-dedup'));
  await writeFile(join(root, '.gitx', '.gitx-store'), 'gitx-store-v2\n');
  expect(await defaults.storePath()).toBe(join(root, '.gitx'));
  await mkdir(join(root, '.cache', 'gitx'), { recursive: true });
  expect(await defaults.storePath()).toBe(join(root, '.gitx'));
  await writeFile(join(root, '.cache', 'gitx', '.gitx-store'), 'gitx-store-v2\n');
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
  const { config, store, api } = await fixture();
  await writeFile(config, '[user]\n name = Test\n');
  const before = await readFile(config, 'utf8');
  const result = await api.doctor();
  expect(result.empty).toBe(true);
  expect(result.checks.map((check) => check.name)).toEqual(['git']);
  expect(result.checks[0]).toMatchObject({ ok: true });
  await expect(readdir(store)).rejects.toMatchObject({ code: 'ENOENT' });
  expect(await readFile(config, 'utf8')).toBe(before);
});

it('doctor recognizes a valid pool and reports an invalid pool without changing either', async () => {
  const { root, store, env, api } = await fixture();
  const pool = join(store, 'pool.git');
  await mkdir(store);
  execFileSync('git', ['init', '--bare', '--object-format=sha1', pool], { cwd: root, env, stdio: 'pipe' });
  expect((await api.doctor()).checks[0]).toMatchObject({ ok: true, detail: expect.stringContaining('SHA-1 bare') });
  await rm(pool, { recursive: true });
  await mkdir(pool);
  await writeFile(join(pool, 'sentinel'), 'unchanged');
  expect(await api.doctor()).toMatchObject({ empty: false, checks: [{ name: 'pool', ok: false }, { name: 'git' }] });
  expect(await readdir(pool)).toEqual(['sentinel']);
});

it('uses git-dedup.gitPath from Git configuration and accepts the old setting', async () => {
  const { config, env, root } = await fixture();
  const binary = execFileSync(process.platform === 'win32' ? 'where' : 'which', ['git'], { encoding: 'utf8' })
    .split(/\r?\n/)[0]!
    .trim();
  // Git config reads a backslash as an escape; forward slashes work on every platform.
  const configured = binary.replaceAll('\\', '/');
  await writeFile(config, `[git-dedup]\n gitPath = ${configured}\n`);
  const api = createGitDedup({ cwd: root, env });
  expect((await api.doctor()).checks.find((check) => check.name === 'git')?.detail).toContain(binary);
  await writeFile(config, `[gitx]\n gitPath = ${configured}\n`);
  expect(
    (await createGitDedup({ cwd: root, env }).doctor()).checks.find((check) => check.name === 'git')?.detail,
  ).toContain(binary);
});
