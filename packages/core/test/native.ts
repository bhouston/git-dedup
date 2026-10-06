/**
 * Runs the shared test suites against a native git-dedup binary. With GIT_DEDUP_BIN set, the exports
 * drive that binary through its test-only `__api` command; otherwise they are the TypeScript implementation.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as typescript from '../src/index.js';
import type { GitDedupOptions, StorageReport } from '../src/index.js';

/** The native binary under test, or undefined when the TypeScript implementation is tested. */
export const nativeBinary = process.env.GIT_DEDUP_BIN || undefined;

const resultDirectory = nativeBinary ? mkdtempSync(join(tmpdir(), 'git-dedup-api-')) : '';
let calls = 0;

interface ApiResult {
  ok: boolean;
  value: unknown;
  error?: string;
  reports: StorageReport[];
}

function prepare(method: string, params: Record<string, unknown>, options: GitDedupOptions) {
  const result = join(resultDirectory, `${process.pid}-${++calls}.json`);
  // Node resolves `~` from its own process environment rather than options.env, so pass the live home.
  const home = Object.fromEntries(
    ['HOME', 'USERPROFILE'].filter((key) => process.env[key] !== undefined).map((key) => [key, process.env[key]]),
  );
  const env = { ...process.env, ...options.env, ...home, GIT_DEDUP_TEST_API: result };
  const payload = { cwd: options.cwd, gitPath: options.gitPath, report: Boolean(options.onStorageReport), ...params };
  return { result, env, args: ['__api', method, JSON.stringify(payload)] };
}

function settle(result: string, options: GitDedupOptions): unknown {
  const parsed = JSON.parse(readFileSync(result, 'utf8')) as ApiResult;
  rmSync(result, { force: true });
  for (const report of parsed.reports) {
    try {
      options.onStorageReport?.(report);
    } catch {
      process.stderr.write('git-dedup: storage report callback failed\n');
    }
  }
  if (!parsed.ok) throw new Error(parsed.error);
  return parsed.value ?? undefined;
}

/** Calls the binary, relaying its output through this process so tests can observe it. */
function call<T>(method: string, params: Record<string, unknown>, options: GitDedupOptions = {}): Promise<T> {
  const { result, env, args } = prepare(method, params, options);
  return new Promise((resolve, reject) => {
    const child = spawn(nativeBinary!, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', (chunk: Buffer) => process.stdout.write(chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => process.stderr.write(chunk.toString()));
    child.once('error', reject);
    child.once('close', () => {
      try {
        resolve(settle(result, options) as T);
      } catch (error) {
        reject(error);
      }
    });
  });
}

function nativeClient(options: GitDedupOptions = {}): ReturnType<typeof typescript.createGitDedup> {
  return {
    run: (args: string[]) => call('run', { args }, options),
    add: (path?: string, quiet = false) => call('add', { path, quiet }, options),
    remove: (path?: string) => call('remove', { path }, options),
    storeInfo: () => call('storeInfo', {}, options),
    listRemotes: () => call('listRemotes', {}, options),
    fetch: () => call('fetch', {}, options),
    gc: () => call('gc', {}, options),
    prune: () => call('prune', {}, options),
    forget: (path: string) => call('forget', { path }, options),
    doctor: () => call('doctor', {}, options),
    storePath: () => call('storePath', {}, options),
    gitVersion: () => call('gitVersion', {}, options),
    gitPath: () => call('gitPath', {}, options),
  };
}

export const createGitDedup: typeof typescript.createGitDedup = nativeBinary ? nativeClient : typescript.createGitDedup;

export const keyForRemote: typeof typescript.keyForRemote = nativeBinary
  ? (remote: string) => {
      const { result, env, args } = prepare('keyForRemote', { remote }, {});
      spawnSync(nativeBinary, args, { env, stdio: 'inherit' });
      return settle(result, {}) as string | undefined;
    }
  : typescript.keyForRemote;

/** The native discovery of checkouts for `store add --all`, matching discoverCheckouts in the CLI package. */
export function nativeDiscoverCheckouts(directory: string, git = 'git') {
  return call<Array<{ path: string; gitDir: string; commonGitDir: string; coveredBy?: string }>>('discover', {
    path: directory,
    git,
  });
}
