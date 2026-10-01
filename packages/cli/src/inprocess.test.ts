import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { StorageReport } from 'git-dedup-core';
import type { Argv } from 'yargs';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { dedup } from './context.js';
import * as docgenCommand from './commands/docgen.js';
import * as addCommand from './commands/store/add.js';
import * as fetchCommand from './commands/store/fetch.js';
import * as gcCommand from './commands/store/gc.js';
import * as listCommand from './commands/store/list.js';
import * as pruneCommand from './commands/store/prune.js';
import * as removeCommand from './commands/store/remove.js';
import * as infoCommand from './commands/store/$default.js';
import { cliDocument, loadCommands } from './document.js';
import { main } from './index.js';
import { printStorageReports } from './stats.js';
import { handler as docgen } from './commands/docgen.js';

// yargs-file-commands loads modules with native import(), which cannot resolve the .js specifiers
// in TypeScript sources, so hand it the same command tree built from already-loaded modules.
vi.mock('yargs-file-commands', () => ({
  fileCommands: async () => [
    { ...docgenCommand },
    {
      command: 'store',
      describe: 'Manage the shared store',
      builder: (y: Argv) => {
        for (const m of [infoCommand, addCommand, fetchCommand, gcCommand, listCommand, pruneCommand, removeCommand])
          y.command({ command: '$0', ...m } as never);
        return y;
      },
      handler: () => {},
    },
  ],
}));

const saved = { ...process.env };
let dir: string;
let out: string[];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'git-dedup-inproc-'));
  process.env.GIT_CONFIG_GLOBAL = join(dir, 'global.gitconfig');
  process.env.GIT_CONFIG_SYSTEM = join(dir, 'system.gitconfig');
  process.env.GIT_DEDUP_STORE = join(dir, 'store');
  out = [];
  const sink = (...a: unknown[]) => void out.push(a.join(' '));
  vi.spyOn(console, 'log').mockImplementation(sink);
  vi.spyOn(console, 'error').mockImplementation(sink);
  vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
  vi.spyOn(process.stderr, 'write').mockImplementation((s) => (out.push(String(s)), true));
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  vi.doUnmock('./index.js');
  process.env = { ...saved };
  process.exitCode = undefined;
  await rm(dir, { recursive: true, force: true });
});

it('main prints a Git-style version line', async () => {
  expect(await main(['--version'])).toBe(0);
  expect(await main(['-v'])).toBe(0);
  expect(out[0]).toMatch(/^git version .* \(git-dedup \d/);
});

it('main shows help without arguments', async () => {
  expect(await main([])).toBe(0);
  expect(out.join('\n')).toContain('git-dedup <command>');
});

it('main runs store commands through yargs', async () => {
  expect(await main(['store', 'list'])).toBe(0);
  expect(out).toContain('No remotes registered.');
  await main(['store']);
  await main(['store', 'gc']);
  await main(['store', 'prune']);
  await main(['store', 'fetch']);
  expect(out.join('\n')).toContain('Fetched 0 remote(s)');
});

it('main forwards Git commands, with and without --stats', async () => {
  expect(await main(['version'])).toBe(0);
  expect(await main(['--stats', 'version'])).toBe(0);
});

it('printStorageReports describes add and clone reports', () => {
  const base = { repository: 'r', poolReused: true, estimatedSavedBytes: 5 } as StorageReport;
  printStorageReports([]);
  expect(out).toEqual([]);
  printStorageReports([{ ...base, operation: 'add', beforeUniqueBytes: 10, afterUniqueBytes: 5 }]);
  printStorageReports([{ ...base, operation: 'add', poolReused: false }]);
  printStorageReports([{ ...base, operation: 'clone' }]);
  const text = out.join('');
  expect(text).toContain('private packs');
  expect(text).toContain('estimated private pack reduction');
  expect(text).toContain('objects borrowed through Git alternates');
  expect(text).toContain('clone storage depends');
});

it('builds the command tree and OpenCLI document', async () => {
  expect((await loadCommands()).length).toBeGreaterThan(0);
  const doc = await cliDocument();
  expect(doc.global?.flags?.[0]?.name).toBe('stats');
  expect(doc.commands?.['git-dedup clone']).toBeDefined();
});

it('docgen writes to a file and to stdout', async () => {
  const file = join(dir, 'doc.json');
  await docgen({ output: file, format: 'json' } as never);
  expect(JSON.parse(await readFile(file, 'utf8')).commands).toHaveProperty(['git-dedup docgen']);
  await docgen({ format: 'yaml' } as never);
  expect(out.join('')).toContain('git-dedup docgen');
});

it('dedup creates a client bound to the isolated store', async () => {
  const info = await dedup().storeInfo();
  expect(info.path.startsWith(await realpath(dir))).toBe(true);
});

it('bin sets the exit code from main or reports its error', async () => {
  vi.doMock('./index.js', () => ({ main: vi.fn().mockResolvedValue(3) }));
  await import('./bin.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(3));

  vi.resetModules();
  vi.doMock('./index.js', () => ({ main: vi.fn().mockRejectedValue(new Error('bad')) }));
  await import('./bin.js');
  await vi.waitFor(() => expect(process.exitCode).toBe(1));
  expect(out).toContain('bad');

  vi.resetModules();
  vi.doMock('./index.js', () => ({ main: vi.fn().mockRejectedValue('plain') }));
  await import('./bin.js');
  await vi.waitFor(() => expect(out).toContain('plain'));
});
