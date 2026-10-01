import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const client = vi.hoisted(() => ({
  gitPath: vi.fn(),
  add: vi.fn(),
  remove: vi.fn(),
  forget: vi.fn(),
  fetch: vi.fn(),
  gc: vi.fn(),
  prune: vi.fn(),
  listRemotes: vi.fn(),
  storeInfo: vi.fn(),
  doctor: vi.fn(),
}));
vi.mock('./context.js', () => ({ dedup: () => client }));

const { handler: add } = await import('./commands/store/add.js');
const { handler: remove } = await import('./commands/store/remove.js');
const { handler: fetch } = await import('./commands/store/fetch.js');
const { handler: gc } = await import('./commands/store/gc.js');
const { handler: prune } = await import('./commands/store/prune.js');
const { handler: list } = await import('./commands/store/list.js');
const { handler: info } = await import('./commands/store/$default.js');

let out: string[];
let err: string[];
const dirs: string[] = [];

beforeEach(() => {
  out = [];
  err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => void out.push(a.join(' ')));
  vi.spyOn(console, 'error').mockImplementation((...a) => void err.push(a.join(' ')));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (err.push(String(s)), true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  Object.values(client).forEach((fn) => fn.mockReset());
  process.exitCode = undefined;
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

const flags = { stats: false, all: false, dryRun: false, verbose: false };
const result = (over = {}) => ({ added: 1, skipped: 0, failed: 0, repositories: [], ...over });
const call = (handler: (a: never) => unknown, args: object) => handler({ ...flags, ...args } as never);

it('add rejects --dry-run without --all', async () => {
  await expect(call(add, { dryRun: true })).rejects.toThrow('--dry-run requires --all');
});

it('add a single path reports repositories and failures', async () => {
  client.add.mockResolvedValue(
    result({
      failed: 1,
      repositories: [
        { path: 'a', status: 'added' },
        { path: 'b', status: 'added', reason: 'warn' },
        { path: 'c', status: 'failed', reason: 'bad', detail: 'details' },
        { path: 'd', status: 'skipped', reason: 'nope' },
      ],
    }),
  );
  await call(add, { path: 'x', verbose: true, stats: true });
  expect(err).toEqual(['Warning b: warn', 'Failed c: bad', 'details', 'Skipped d: nope']);
  expect(out).toEqual(['Added 1 repository(s); skipped 0; failed 1.']);
  expect(process.exitCode).toBe(1);
});

it('add --all discovers checkouts, honors dry-run, and counts failures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-dedup-handlers-'));
  dirs.push(root);
  const parent = join(root, 'parent');
  execFileSync('git', ['init', '-q', parent], { env: { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'g') } });
  await mkdir(join(root, 'other'));
  client.gitPath.mockResolvedValue('git');
  await call(add, { all: true, dryRun: true, path: root });
  expect(out).toEqual(['Discovered 1 checkout(s):', `  ${parent}`]);

  client.add.mockRejectedValue(new Error('boom'));
  await call(add, { all: true, path: root, verbose: true, stats: true });
  expect(err).toContain(`Failed ${parent}: store add operation failed`);
  expect(err).toContain('boom');
  expect(out.at(-1)).toBe('Added 0 repository(s); skipped 0; failed 1.');
  expect(process.exitCode).toBe(1);

  process.exitCode = undefined;
  err.length = 0;
  client.add.mockRejectedValue('str');
  await call(add, { all: true, path: root });
  expect(err).toEqual([`Failed ${parent}: store add operation failed`]);

  client.add.mockResolvedValue(result({ repositories: [{ path: parent, status: 'added', reason: 'w' }] }));
  process.exitCode = undefined;
  await call(add, { all: true, path: root });
  expect(out.at(-1)).toBe('Added 1 repository(s); skipped 0; failed 0.');
  expect(process.exitCode).toBeUndefined();
});

it('add --all skips submodules already handled with their parent', async () => {
  const root = await mkdtemp(join(tmpdir(), 'git-dedup-handlers-'));
  dirs.push(root);
  const env = { ...process.env, GIT_CONFIG_GLOBAL: join(root, 'g'), GIT_CONFIG_SYSTEM: join(root, 's') };
  const git = (...a: string[]) =>
    execFileSync(
      'git',
      ['-c', 'protocol.file.allow=always', '-c', 'user.name=t', '-c', 'user.email=t@e.invalid', ...a],
      { env, stdio: 'pipe' },
    );
  const sub = join(root, 'sub');
  const parent = join(root, 'parent');
  git('init', '-q', sub);
  git('-C', sub, 'commit', '-q', '--allow-empty', '-m', 'i');
  git('init', '-q', parent);
  git('-C', parent, 'submodule', 'add', '-q', sub, 'deps');
  client.gitPath.mockResolvedValue('git');
  client.add.mockResolvedValue(result());
  await call(add, { all: true, path: root });
  expect(out.some((l) => l.startsWith('Skipped') && l.includes('handled with'))).toBe(true);
});

it('remove --forget', async () => {
  client.forget.mockResolvedValue(['g1']);
  await call(remove, { path: 'p', forget: true });
  expect(out).toEqual(['Forgot g1']);
  client.forget.mockResolvedValue([]);
  await call(remove, { path: 'p', forget: true });
  expect(err).toEqual(['No registered checkout matches p.']);
  expect(process.exitCode).toBe(1);
});

it('remove reports each repository outcome', async () => {
  client.remove.mockResolvedValue({
    removed: 1,
    skipped: 1,
    failed: 1,
    repositories: [
      { path: 'a', status: 'removed', objectBytes: 10, detail: 'd1' },
      { path: 'b', status: 'removed' },
      { path: 'c', status: 'failed', reason: 'bad' },
      { path: 'd', status: 'skipped', reason: 'no' },
    ],
  });
  await call(remove, { path: 'p', verbose: true });
  expect(out[0]).toMatch(/^Removed a: objects now use /);
  expect(err).toEqual(['d1', 'Failed c: bad', 'Skipped d: no']);
  expect(out.at(-1)).toBe('Removed 1 repository(s); skipped 1; failed 1.');
  expect(process.exitCode).toBe(1);
});

it('remove with nothing linked', async () => {
  client.remove.mockResolvedValue({ removed: 0, skipped: 0, failed: 0, repositories: [] });
  await call(remove, { path: 'p' });
  expect(out).toEqual(['Nothing to remove: p is not linked to the store.']);
});

it('fetch, gc, prune, list', async () => {
  client.fetch.mockResolvedValue({
    fetched: 1,
    failed: 1,
    remotes: [
      { key: 'k', status: 'failed', reason: 'r' },
      { key: 'j', status: 'ok' },
    ],
  });
  await call(fetch, {});
  expect(err).toEqual(['Failed k: r']);
  expect(process.exitCode).toBe(1);
  process.exitCode = undefined;
  client.fetch.mockResolvedValue({ fetched: 0, failed: 0, remotes: [] });
  await call(fetch, {});
  expect(process.exitCode).toBeUndefined();

  client.gc.mockResolvedValue({ compacted: true });
  await call(gc, {});
  client.gc.mockResolvedValue({ compacted: false });
  await call(gc, {});
  client.prune.mockResolvedValue({ reclaimedBytes: 0 });
  await call(prune, {});
  expect(out).toContain('Compacted the shared object pool.');
  expect(out).toContain('The shared object pool is empty.');

  client.listRemotes.mockResolvedValue([]);
  await call(list, {});
  client.listRemotes.mockResolvedValue([{ key: 'k', remote: 'u' }]);
  await call(list, {});
  expect(out).toContain('No remotes registered.');
  expect(out).toContain('k\tu');
});

it('store info prints health and sets exit code on warnings', async () => {
  client.storeInfo.mockResolvedValue({ path: '/s', remoteCount: 0, sizeBytes: 0 });
  client.doctor.mockResolvedValue({ empty: true, checks: [{ ok: true, name: 'a', detail: 'd' }] });
  await call(info, {});
  expect(out.join('\n')).toContain('The store is empty.');
  expect(process.exitCode).toBeUndefined();
  client.doctor.mockResolvedValue({ empty: false, checks: [{ ok: false, name: 'b', detail: 'x' }] });
  await call(info, {});
  expect(out).toContain('WARN b: x');
  expect(process.exitCode).toBe(1);
});
