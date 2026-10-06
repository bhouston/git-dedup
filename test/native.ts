/**
 * Drives the git-dedup binary through its test-only `__api` command, so the suites can test the storage
 * operations directly. GIT_DEDUP_BIN overrides the binary that `pnpm build` places for this platform.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export interface StorageReport {
  operation: 'clone' | 'fetch' | 'add';
  repository: string;
  poolReused: boolean;
  estimatedSavedBytes: number;
  beforeUniqueBytes?: number;
  afterUniqueBytes?: number;
}

export interface GitDedupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  gitPath?: string;
  onStorageReport?: (report: StorageReport) => void;
}

/** The binary under test. */
export const nativeBinary =
  process.env.GIT_DEDUP_BIN ||
  fileURLToPath(
    new URL(
      `../packages/cli/native/${process.platform}-${process.arch}/git-dedup${process.platform === 'win32' ? '.exe' : ''}`,
      import.meta.url,
    ),
  );

/** The npm launcher, which runs the binary for this platform. */
export const launcher = fileURLToPath(new URL('../packages/cli/bin/git-dedup.js', import.meta.url));

const resultDirectory = mkdtempSync(join(tmpdir(), 'git-dedup-api-'));
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
    const child = spawn(nativeBinary, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
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

interface RepositoryResult {
  path: string;
  status: string;
  reason?: string;
  detail?: string;
  objectBytes?: number;
}
interface Counts {
  added: number;
  removed: number;
  skipped: number;
  failed: number;
  repositories: RepositoryResult[];
}
interface FetchResult {
  fetched: number;
  failed: number;
  remotes: Array<{ key: string; status: string; reason?: string; detail?: string }>;
}
interface DoctorResult {
  empty: boolean;
  checks: Array<{ name: string; ok: boolean; detail: string }>;
}

export function createGitDedup(options: GitDedupOptions = {}) {
  return {
    run: (args: string[]) => call<number>('run', { args }, options),
    add: (path?: string, quiet = false) => call<Counts>('add', { path, quiet }, options),
    remove: (path?: string) => call<Counts>('remove', { path }, options),
    storeInfo: () => call<{ path: string; sizeBytes: number; remoteCount: number }>('storeInfo', {}, options),
    listRemotes: () => call<Array<{ key: string; remote: string }>>('listRemotes', {}, options),
    fetch: () => call<FetchResult>('fetch', {}, options),
    gc: () => call<{ compacted: boolean }>('gc', {}, options),
    prune: () => call<{ reclaimedBytes: number }>('prune', {}, options),
    forget: (path: string) => call<string[]>('forget', { path }, options),
    doctor: () => call<DoctorResult>('doctor', {}, options),
    storePath: () => call<string>('storePath', {}, options),
    gitVersion: () => call<string>('gitVersion', {}, options),
    gitPath: () => call<string>('gitPath', {}, options),
  };
}

export function keyForRemote(remote: string): string | undefined {
  const { result, env, args } = prepare('keyForRemote', { remote }, {});
  spawnSync(nativeBinary, args, { env, stdio: 'inherit' });
  return settle(result, {}) as string | undefined;
}

/** Discovers checkouts as `store add --all` does. */
export function discoverCheckouts(directory: string, git = 'git') {
  return call<Array<{ path: string; gitDir: string; commonGitDir: string; coveredBy?: string }>>('discover', {
    path: directory,
    git,
  });
}

/** Resolves once a local TCP port accepts connections, such as a `git daemon` that is still starting. */
export async function waitForPort(port: number, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    if (Date.now() > deadline) throw new Error(`Nothing listened on port ${port} within ${timeoutMs} ms`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
