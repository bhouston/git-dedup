import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import { access, mkdir, readdir, readFile, realpath, rename, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { homedir, constants as osConstants } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export interface GitDedupOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  gitPath?: string;
  onStorageReport?: (report: StorageReport) => void;
}
export interface StorageReport {
  operation: 'clone' | 'add';
  repository: string;
  poolReused: boolean;
  estimatedSavedBytes: number;
  /** Logical bytes in private pack files before/after checkout adoption. Loose objects are excluded. */
  beforeUniqueBytes?: number;
  afterUniqueBytes?: number;
}
export interface StoreInfo {
  path: string;
  sizeBytes: number;
  remoteCount: number;
}
export interface StoreRemote {
  key: string;
  remote: string;
}
export interface PruneResult {
  reclaimedBytes: number;
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DoctorResult {
  /** True when no object pool exists yet; the pool check is then omitted. */
  empty: boolean;
  checks: DoctorCheck[];
}
export interface StoreAddResult {
  added: number;
  skipped: number;
  failed: number;
  repositories: StoreAddRepositoryResult[];
}
export interface StoreAddRepositoryResult {
  path: string;
  status: 'added' | 'skipped' | 'failed';
  reason?: string;
  /** Full underlying error for diagnostic output. */
  detail?: string;
}
export interface StoreRemoveResult {
  removed: number;
  skipped: number;
  failed: number;
  repositories: StoreRemoveRepositoryResult[];
}
export interface StoreRemoveRepositoryResult {
  path: string;
  status: 'removed' | 'skipped' | 'failed';
  reason?: string;
  /** Full underlying error for diagnostic output. */
  detail?: string;
  /** Bytes in the checkout's own object directory after removal. */
  objectBytes?: number;
}

export interface StoreFetchResult {
  fetched: number;
  failed: number;
  remotes: StoreFetchRemoteResult[];
}
export interface StoreFetchRemoteResult {
  key: string;
  status: 'fetched' | 'failed';
  reason?: string;
  /** Full underlying error for diagnostic output. */
  detail?: string;
}

function addFailureReason(error: unknown, stage: string): string {
  const message = String(error);
  if (/cannot lock ref|reference already exists|case.insensitive|refname collision/i.test(message))
    return 'ref collision in the shared pool';
  if (stage === 'remote fetch' || /could not resolve host|connection refused|network is unreachable/i.test(message))
    return 'remote fetch failed';
  if (/Unsupported Git object format/i.test(message)) return 'unsupported object format';
  return 'Git storage operation failed';
}

type GitResult = { code: number; stdout: string; stderr: string };

function expandHome(value: string): string {
  return value === '~' ? homedir() : value.startsWith('~/') ? join(homedir(), value.slice(2)) : value;
}

function isPresent(path: string): Promise<boolean> {
  return access(path, constants.F_OK).then(
    () => true,
    () => false,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

function keyForRemote(remote: string): string | undefined {
  let host: string;
  let port = '';
  let user: string | undefined;
  let pathname: string;
  const scp = remote.match(/^([^/@:]+)@([^/:]+):(.+)$/);
  if (scp) {
    [, user, host, pathname] = scp as [string, string, string, string];
    if (!pathname.startsWith('/')) pathname = `/~/${pathname}`;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return undefined;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    host = url.hostname;
    // `:` cannot appear in a host name, so ports never collide with hosts.
    port = url.port ? `:${url.port}` : '';
    if (url.protocol === 'ssh:') user = url.username;
    pathname = url.pathname;
  }
  // Home-relative SSH paths differ per user; `git` is the shared hosting account convention.
  let home = '';
  if (user !== undefined && pathname.startsWith('/~/')) {
    pathname = pathname.slice(2);
    if (user !== 'git') home = `~${user}/`;
  }
  const parts = pathname
    .replace(/^\/+/, '')
    .replace(/\.git\/?$/, '')
    .split('/');
  if (
    !host ||
    parts.length < 2 ||
    parts.some((part) => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/.test(part))
  )
    return undefined;
  if (!/^[a-zA-Z0-9._-]+$/.test(host)) return undefined;
  return `${host.toLowerCase()}${port}/${home}${parts.join('/')}`;
}

async function directorySize(path: string): Promise<number> {
  let size = 0;
  for (const entry of await readdir(path, { withFileTypes: true }).catch(() => [])) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) size += await directorySize(child);
    else if (entry.isFile()) size += (await stat(child)).size;
  }
  return size;
}

const remoteId = (key: string): string => createHash('sha256').update(key).digest('hex');

function unsupportedClone(args: string[]): string | undefined {
  return args.find((arg) =>
    /^(--depth|--shallow|--filter|--mirror|--bare|--reference|--dissociate|--no-hardlinks|--shared|--separate-git-dir|--bundle-uri|--sparse|--upload-pack|--server-option|--template|--config|--origin|--no-checkout|--single-branch|--no-single-branch|--revision|--jobs|-j|-o|-u|-c)(=|$)/.test(
      arg,
    ),
  );
}

/** Reports a handled command that is forwarded to plain Git, unless Git was asked to be quiet. */
function fallback(args: string[], reason: string): undefined {
  if (!args.includes('-q') && !args.includes('--quiet'))
    process.stderr.write(`git-dedup: ${reason}; using plain Git\n`);
  return undefined;
}

/** The last Git `fatal:` or `error:` line of a failure, without captured progress output. */
function gitFailure(error: unknown): string {
  const line = String(error)
    .match(/\b(?:fatal|error): [^\r\n]*/g)
    ?.at(-1)
    ?.trim();
  return line ? ` (${line})` : '';
}

/** Returns the parsed clone, or the reason git-dedup cannot handle it. */
function parseClone(
  args: string[],
): { remote: string; destination?: string; recurse: boolean; branch?: string; forwarded: string[] } | string {
  const unsupported = unsupportedClone(args);
  if (unsupported) return `clone option ${unsupported.split('=')[0]} is not supported`;
  const positional: string[] = [];
  let recurse = false;
  let branch: string | undefined;
  const forwarded: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (arg === '-b' || arg === '--branch') {
      branch = args[++i];
      if (!branch) return `clone option ${arg} requires a value`;
      forwarded.push(arg, branch);
      continue;
    }
    if (arg.startsWith('--branch=')) {
      branch = arg.slice(9);
      forwarded.push(arg);
      continue;
    }
    // VS Code's Git: Clone passes --recursive, Git's alias for --recurse-submodules.
    if (arg === '--recurse-submodules' || arg === '--recursive') {
      recurse = true;
      continue;
    }
    if (['-q', '--quiet', '-v', '--verbose', '--progress', '--no-tags'].includes(arg)) {
      forwarded.push(arg);
      continue;
    }
    if (arg.startsWith('-')) return `clone option ${arg.split('=')[0]} is not supported`;
    positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) return 'clone expects a repository and an optional directory';
  if (positional.includes('')) return 'clone does not support an empty argument';
  return { remote: positional[0]!, destination: positional[1], recurse, branch, forwarded };
}

function defaultCloneName(remote: string): string {
  // Like Git, a local `repo/.git` clones into `repo`.
  return remote
    .replace(/\/+$/, '')
    .replace(/\/\.git$/, '')
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, '');
}

function submoduleAddPath(args: string[]): string | undefined {
  const positional: string[] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    // Options of `git submodule add` that take a separate value.
    if (['-b', '--branch', '--reference', '--ref-format', '--name', '--depth'].includes(arg)) i++;
    else if (!arg.startsWith('-')) positional.push(arg);
  }
  if (positional.length === 1) return defaultCloneName(positional[0]!);
  return positional.length === 2 ? positional[1] : undefined;
}

function resolveSubmoduleRemote(parent: string, child: string): string | undefined {
  if (!child.startsWith('./') && !child.startsWith('../')) return child;
  if (!keyForRemote(parent)) return undefined;
  if (/^[^/@:]+@[^/:]+:.+/.test(parent)) {
    const at = parent.indexOf(':');
    const base = parent.slice(at + 1).split('/');
    for (const part of child.split('/')) {
      if (part === '..') base.pop();
      else if (part !== '.') base.push(part);
    }
    return `${parent.slice(0, at + 1)}${base.join('/')}`;
  }
  try {
    return new URL(child, parent.endsWith('/') ? parent : parent + '/').toString();
  } catch {
    return undefined;
  }
}

function parseGlobal(
  args: string[],
  cwd: string,
): { prefix: string[]; command: string; rest: string[]; cwd: string } | undefined {
  const prefix: string[] = [];
  let i = 0;
  while (i < args.length) {
    const arg = args[i]!;
    if (
      arg === '-C' ||
      arg === '-c' ||
      arg === '--git-dir' ||
      arg === '--work-tree' ||
      arg === '--namespace' ||
      arg === '--config-env'
    ) {
      if (!args[i + 1]) return undefined;
      prefix.push(arg, args[i + 1]!);
      if (arg === '-C') cwd = resolve(cwd, args[i + 1]!);
      i += 2;
      continue;
    }
    if (/^(--git-dir|--work-tree|--namespace|--config-env)=/.test(arg) || arg.startsWith('-c')) {
      prefix.push(arg);
      i++;
      continue;
    }
    if (arg.startsWith('-')) return undefined;
    return { prefix, command: arg, rest: args.slice(i + 1), cwd };
  }
  return undefined;
}

async function canonicalPath(path: string): Promise<string> {
  const existing = await realpath(path).catch(() => undefined);
  if (existing) return existing;
  const parent = dirname(path);
  return parent === path ? path : join(await canonicalPath(parent), basename(path));
}

// A holder touches its heartbeat file; a waiter that sees the lock unchanged this long treats it as abandoned.
const LOCK_STALE_MS = 60_000;

async function lockDirectory<T>(lock: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lock), { recursive: true });
  let seen = '';
  let seenSince = 0;
  for (let attempts = 0; ; attempts++) {
    try {
      await mkdir(lock);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const state = await inspectLock(lock);
    if (attempts === 20)
      process.stderr.write(
        `git-dedup: waiting for the object pool lock ${lock} (owner pid ${state.owner || 'unknown'})\n`,
      );
    // Monotonic time pauses during sleep, so a holder suspended with the machine is not mistaken for a hung one.
    if (state.key !== seen) [seen, seenSince] = [state.key, performance.now()];
    // A dead owner may be reaped. A live but slow Git process must never lose its lock: it keeps its
    // heartbeat fresh. A lock from a version without a heartbeat still waits on a live owner.
    const dead = state.owner > 0 && !processExists(state.owner) && state.age > 5000;
    const silent = (!state.owner || state.heartbeat) && performance.now() - seenSince > LOCK_STALE_MS;
    if (dead || silent) await reapLock(lock, state.key);
    await delay(50);
  }
  const heartbeat = join(lock, 'heartbeat');
  const timer = setInterval(() => {
    const now = new Date();
    void utimes(heartbeat, now, now).catch(() => {});
  }, LOCK_STALE_MS / 6);
  timer.unref();
  try {
    await writeFile(join(lock, 'owner'), `${process.pid}\n`);
    await writeFile(heartbeat, '');
    return await action();
  } finally {
    clearInterval(timer);
    await rm(lock, { recursive: true, force: true });
  }
}

async function inspectLock(lock: string) {
  const [dir, owner, heartbeat] = await Promise.all([
    stat(lock).catch(() => undefined),
    readFile(join(lock, 'owner'), 'utf8').catch(() => ''),
    stat(join(lock, 'heartbeat')).catch(() => undefined),
  ]);
  return {
    key: `${dir?.ino}:${dir?.mtimeMs}:${owner}:${heartbeat?.mtimeMs}`,
    owner: Number(owner.trim()) || 0,
    heartbeat: Boolean(heartbeat),
    age: dir ? Date.now() - dir.mtimeMs : 0,
  };
}

/** Removes the lock only if it is still the one the caller judged stale, one reaper at a time. */
async function reapLock(lock: string, key: string): Promise<void> {
  const guard = `${lock}.reap`;
  try {
    await mkdir(guard);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    // ponytail: a reaper killed mid-reap strands its guard, and two waiters clearing that stranded guard can
    // still race. That needs a crash inside a millisecond window first; give the guard an owner if it ever bites.
    const guardAge = Date.now() - ((await stat(guard).catch(() => undefined))?.mtimeMs ?? Date.now());
    if (guardAge > LOCK_STALE_MS) await rm(guard, { recursive: true, force: true });
    return;
  }
  try {
    if ((await inspectLock(lock)).key !== key) return;
    const tombstone = `${lock}.${randomUUID()}.reaped`;
    await rename(lock, tombstone).catch(() => {});
    await rm(tombstone, { recursive: true, force: true });
  } finally {
    await rm(guard, { recursive: true, force: true });
  }
}

function storeLock(root: string): string {
  return join(dirname(root), `.${basename(root)}.gitx-lock`);
}

async function initializeStore(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const marker = join(root, '.gitx-store');
  if (await isPresent(marker)) {
    if ((await readFile(marker, 'utf8')) !== 'gitx-store-v2\n')
      throw new Error(`Invalid git-dedup store marker: ${root}`);
    return;
  }
  if ((await readdir(root)).length) throw new Error(`Refusing to adopt a nonempty directory as a store: ${root}`);
  await writeFile(marker, 'gitx-store-v2\n', { flag: 'wx' });
}

async function uniquePackBytes(gitdir: string): Promise<number> {
  let bytes = 0;
  for (const name of await readdir(join(gitdir, 'objects', 'pack')).catch(() => [])) {
    if (!/\.(pack|idx|rev)$/.test(name)) continue;
    const file = await stat(join(gitdir, 'objects', 'pack', name)).catch(() => undefined);
    if (file?.nlink === 1) bytes += file.size;
  }
  return bytes;
}

async function withLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  // One Git object database needs one writer at a time. Keep the lock outside the store.
  return lockDirectory(storeLock(root), async () => {
    await initializeStore(root);
    return action();
  });
}

function poolPath(root: string): string {
  return join(root, 'pool.git');
}

// Keep URL credentials out of the store; Git credential helpers supply them at fetch time.
// HTTP(S) userinfo is a credential. Other schemes keep the user name, which SSH needs.
function redactRemote(remote: string, mask = ''): string {
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)([^/?#]*)@/i, (authority, scheme: string, userinfo: string) => {
    const user = /^https?:/i.test(scheme) ? '' : userinfo.split(':')[0];
    if (user === userinfo) return authority;
    const kept = user + (mask && (user ? ':' : '') + mask);
    return scheme + (kept && `${kept}@`);
  });
}

function registration(remote: string, key: string): string {
  return JSON.stringify({ key, remote: redactRemote(remote) }) + '\n';
}

async function registerRemote(root: string, remote: string, key: string): Promise<void> {
  const id = remoteId(key);
  await mkdir(join(root, 'remotes'), { recursive: true });
  await writeFile(join(root, 'remotes', `${id}.json`), registration(remote, key));
}

async function registerConsumer(root: string, id: string, gitdir: string): Promise<void> {
  await mkdir(join(root, 'consumers'), { recursive: true });
  await writeFile(join(root, 'consumers', `${id}.json`), JSON.stringify({ gitdir }) + '\n');
}

async function registeredConsumers(root: string): Promise<Map<string, string>> {
  const consumers = new Map<string, string>();
  for (const name of await readdir(join(root, 'consumers')).catch(() => [])) {
    const value: unknown = JSON.parse(await readFile(join(root, 'consumers', name), 'utf8'));
    const id = name.replace(/\.json$/, '');
    if (
      !/^[a-f0-9-]{36}$/.test(id) ||
      !value ||
      typeof value !== 'object' ||
      !('gitdir' in value) ||
      typeof value.gitdir !== 'string'
    )
      throw new Error(`Invalid git-dedup consumer registration: ${name}`);
    consumers.set(id, value.gitdir);
  }
  return consumers;
}

/** Pseudorefs and in-progress rebase or cherry-pick state can name fetched commits no ref holds. */
async function stateOids(gitdir: string): Promise<string[]> {
  const files = ['FETCH_HEAD', 'ORIG_HEAD', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD'].map(
    (name) => join(gitdir, name),
  );
  for (const directory of ['rebase-merge', 'rebase-apply', 'sequencer'])
    for (const entry of await readdir(join(gitdir, directory), { withFileTypes: true }).catch(() => []))
      if (entry.isFile()) files.push(join(gitdir, directory, entry.name));
  const oids: string[] = [];
  for (const file of files)
    oids.push(...((await readFile(file, 'utf8').catch(() => '')).match(/\b[0-9a-f]{40}\b/g) ?? []));
  return oids;
}

async function carriesConsumerId(gitdir: string, id: string): Promise<boolean> {
  const current = await readFile(join(gitdir, 'gitx-consumer-id'), 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return '';
    throw error;
  });
  return current.trim() === id;
}

function checkoutPath(gitdir: string): string {
  return basename(gitdir) === '.git' ? dirname(gitdir) : gitdir;
}

function alternateLines(content: string): string[] {
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
}

async function setAlternate(gitdir: string, pool: string): Promise<void> {
  const alternate = join(gitdir, 'objects', 'info', 'alternates');
  await mkdir(dirname(alternate), { recursive: true });
  const target = join(pool, 'objects');
  const lines = alternateLines(await readFile(alternate, 'utf8').catch(() => ''));
  if (lines.includes(target)) return;
  await writeFile(alternate, [...lines, target].join('\n') + '\n');
}

async function removeLegacyKeeps(gitdir: string): Promise<void> {
  const packDirectory = join(gitdir, 'objects', 'pack');
  for (const name of await readdir(packDirectory).catch(() => [])) {
    if (!name.endsWith('.keep')) continue;
    const path = join(packDirectory, name);
    if ((await readFile(path, 'utf8').catch(() => '')) === 'gitx base pack\n') await rm(path);
  }
}

/** True when `id` is registered to a different gitdir that still carries it, so `gitdir` is a copy (cp -R). */
async function ownedElsewhere(root: string, id: string, gitdir: string): Promise<boolean> {
  const owner = await readFile(join(root, 'consumers', `${id}.json`), 'utf8').then(
    (text) => (JSON.parse(text) as { gitdir?: unknown }).gitdir,
    () => undefined,
  );
  return (
    typeof owner === 'string' &&
    (await canonicalPath(owner)) !== (await canonicalPath(gitdir)) &&
    (await carriesConsumerId(owner, id))
  );
}

async function consumerId(root: string, commonGitdir: string): Promise<string> {
  // Shared across linked worktrees so a tip is pinned only once per object database.
  const path = join(commonGitdir, 'gitx-consumer-id');
  const existing = (await readFile(path, 'utf8').catch(() => '')).trim();
  if (/^[a-f0-9-]{36}$/.test(existing)) {
    if (!(await ownedElsewhere(root, existing, commonGitdir))) return existing;
    // A copied checkout must not share the original's pins or registration.
    const id = randomUUID();
    await writeFile(path, `${id}\n`);
    return id;
  }
  const id = randomUUID();
  try {
    await writeFile(path, `${id}\n`, { flag: 'wx' });
    return id;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return (await readFile(path, 'utf8')).trim();
  }
}

export function createGitDedup(options: GitDedupOptions = {}) {
  if (process.platform === 'win32')
    throw new Error(
      'git-dedup does not support Windows yet. Run it inside WSL, or use Git directly. See https://github.com/bhouston/git-dedup/issues/74',
    );
  const cwd = resolve(options.cwd ?? process.cwd());
  const incomingEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const env: NodeJS.ProcessEnv = { ...incomingEnv, GITX_ACTIVE: '1', GIT_DEDUP_ACTIVE: '1' };
  let cachedGit: string | undefined;
  function emitStorageReport(report: StorageReport): void {
    try {
      options.onStorageReport?.(report);
    } catch {
      process.stderr.write('git-dedup: storage report callback failed\n');
    }
  }
  const hasRepositoryEnvironment = [
    'GIT_DIR',
    'GIT_WORK_TREE',
    'GIT_COMMON_DIR',
    'GIT_OBJECT_DIRECTORY',
    'GIT_ALTERNATE_OBJECT_DIRECTORIES',
    'GIT_INDEX_FILE',
  ].some((key) => env[key]);

  async function gitPath(): Promise<string> {
    if (cachedGit) return cachedGit;
    const own = await realpath(process.argv[1] ?? '').catch(() => '');
    let candidate: string | undefined = options.gitPath;
    if (!candidate) {
      for (const pathPart of (env.PATH ?? '').split(delimiter)) {
        const path = resolve(cwd, pathPart || '.', 'git');
        const actual = await realpath(path).catch(() => '');
        if (!actual || actual === own) continue;
        if (
          await access(path, constants.X_OK).then(
            () => true,
            () => false,
          )
        ) {
          candidate = path;
          break;
        }
      }
      if (!candidate) throw new Error('Real Git executable not found on PATH');
      const configured =
        (await promisify(execFile)(candidate, ['config', '--get', 'git-dedup.gitPath'], { cwd, env }).then(
          (result) => result.stdout.trim(),
          () => '',
        )) ||
        (await promisify(execFile)(candidate, ['config', '--get', 'gitx.gitPath'], { cwd, env }).then(
          (result) => result.stdout.trim(),
          () => '',
        ));
      if (configured) candidate = resolve(cwd, expandHome(configured));
    }
    const actual = await realpath(candidate).catch(() => '');
    if (!actual || actual === own)
      throw new Error('git-dedup.gitPath must point to a real Git executable, not git-dedup itself');
    await access(candidate, constants.X_OK);
    return (cachedGit = candidate);
  }

  // 'tee' captures output like the default and also streams stderr (Git progress) to the user.
  async function git(args: string[], at = cwd, inherit: boolean | 'tee' = false, input?: string): Promise<GitResult> {
    const binary = await gitPath();
    return new Promise((resolveResult, reject) => {
      const child = spawn(binary, args, {
        cwd: at,
        env,
        stdio: inherit === true ? 'inherit' : [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      });
      child.stdin?.end(input);
      let stdout = '';
      let stderr = '';
      if (inherit !== true) {
        child.stdout?.on('data', (b) => {
          stdout += b;
        });
        child.stderr?.on('data', (b) => {
          stderr += b;
          if (inherit === 'tee') process.stderr.write(b);
        });
      }
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      const handlers = signals.map((signal) => () => {
        child.kill(signal);
      });
      const cleanup = () => {
        if (inherit === true) signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!));
      };
      if (inherit === true) signals.forEach((signal, i) => process.on(signal, handlers[i]!));
      child.on('error', (error) => {
        cleanup();
        reject(error);
      });
      child.on('close', (code, signal) => {
        cleanup();
        resolveResult({ code: code ?? (signal ? 128 + (osConstants.signals[signal] ?? 0) : 1), stdout, stderr });
      });
    });
  }

  async function checked(args: string[], at = cwd, progress = false, input?: string): Promise<string> {
    if (hasRepositoryEnvironment)
      throw new Error(
        'Unset Git repository override environment variables before running git-dedup storage operations',
      );
    const result = await git(args, at, progress && 'tee', input);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  async function storePath(): Promise<string> {
    const configured = env.GIT_DEDUP_STORE || env.GITX_STORE;
    if (configured) return canonicalPath(resolve(cwd, expandHome(configured)));
    for (const legacy of ['~/.cache/gitx', '~/.gitx']) {
      const path = expandHome(legacy);
      const marker = await readFile(join(path, '.gitx-store'), 'utf8').catch(() => '');
      if (marker === 'gitx-store-v2\n') return canonicalPath(path);
    }
    return canonicalPath(expandHome('~/.git-dedup'));
  }

  async function ensurePool(root: string): Promise<string> {
    const pool = poolPath(root);
    if (!(await isPresent(pool))) await checked(['init', '--bare', '--object-format=sha1', pool]);
    if ((await checked(['-C', pool, 'rev-parse', '--show-object-format'])) !== 'sha1')
      throw new Error('Unsupported Git object format in shared pool');
    // Git fsck in an alternate consumer can misread a commit graph from a pool
    // containing unrelated histories. The graph is derived data, so omit it.
    await checked(['-C', pool, 'config', 'gc.writeCommitGraph', 'false']);
    await checked(['-C', pool, 'config', 'maintenance.commit-graph.enabled', 'false']);
    // Consumers borrow objects that a force push can leave unreachable in the
    // pool. Automatic gc would prune them, so only store prune deletes objects,
    // after re-pinning every live consumer.
    await checked(['-C', pool, 'config', 'gc.auto', '0']);
    await checked(['-C', pool, 'config', 'maintenance.auto', 'false']);
    await checked(['-C', pool, 'config', 'gc.pruneExpire', 'never']);
    await rm(join(pool, 'objects', 'info', 'commit-graph'), { force: true });
    await rm(join(pool, 'objects', 'info', 'commit-graphs'), { recursive: true, force: true });
    return pool;
  }

  async function fetchRemote(root: string, remote: string, key: string, progress = false): Promise<string> {
    const pool = await ensurePool(root);
    await fetchRemoteObjects(pool, remote, key, progress);
    await registerRemote(root, remote, key);
    return pool;
  }

  async function fetchRemoteObjects(pool: string, remote: string, key: string, progress = false): Promise<void> {
    const id = remoteId(key);
    process.stderr.write(`git-dedup: updating object pool for ${key}\n`);
    await checked(
      [
        '-C',
        pool,
        'fetch',
        '--no-tags',
        ...(progress ? ['--progress'] : []),
        remote,
        `+refs/heads/*:refs/gitx/remotes/${id}/heads/*`,
        `+refs/tags/*:refs/gitx/remotes/${id}/tags/*`,
      ],
      cwd,
      progress,
    );
  }

  async function consumerTips(repo: string): Promise<string[]> {
    const refs = await checked(['for-each-ref', '--format=%(objectname)', 'refs'], repo);
    // An unborn HEAD (orphan branch, bare repo naming a missing branch) has no tip to pin.
    const head = await git(['rev-parse', '--verify', '-q', 'HEAD'], repo);
    const tips = refs.split('\n').filter(Boolean);
    if (head.code === 0) tips.push(head.stdout.trim());
    return [...new Set(tips)].toSorted();
  }

  async function unpinnedTips(pool: string, id: string, tips: string[]): Promise<string[]> {
    // A tip that a remote ref holds needs no pin until the remote moves. Only
    // store prune deletes objects, and it re-pins every live consumer first.
    const held = new Set(
      (
        await checked([
          '-C',
          pool,
          'for-each-ref',
          '--format=%(objectname)',
          `refs/gitx/consumers/${id}`,
          'refs/gitx/remotes',
        ])
      ).split('\n'),
    );
    return tips.filter((oid) => !held.has(oid));
  }

  async function pinConsumer(pool: string, repo: string, commonGitdir: string, tips: string[]): Promise<void> {
    // Immutable snapshots keep old tips reachable after force pushes, branch
    // deletion, or a later store add call on the same checkout. Source ref names
    // cannot be copied into a files-backed pool: refs differing only by case
    // collide on case-insensitive filesystems. Object IDs are safe ref names,
    // and one pin per distinct tip preserves the same reachability.
    const id = await consumerId(dirname(pool), commonGitdir);
    // Register before pinning: prune refuses to run while pins lack a registration.
    await registerConsumer(dirname(pool), id, commonGitdir);
    const missing = await unpinnedTips(pool, id, tips);
    // Keep fetch argument lists bounded for repositories with many refs.
    for (let offset = 0; offset < missing.length; offset += 128)
      await checked([
        '-C',
        pool,
        'fetch',
        '--no-tags',
        repo,
        ...missing.slice(offset, offset + 128).map((oid) => `+${oid}:refs/gitx/consumers/${id}/${oid}`),
      ]);
  }

  async function repoGitdir(path: string): Promise<string> {
    const value = await checked(['rev-parse', '--absolute-git-dir'], path);
    return value;
  }

  async function repoCommonGitdir(path: string): Promise<string> {
    return checked(['rev-parse', '--path-format=absolute', '--git-common-dir'], path);
  }

  async function origin(path: string): Promise<string | undefined> {
    const result = await git(['remote', 'get-url', 'origin'], path);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async function remoteKey(remote: string, at = cwd): Promise<string | undefined> {
    const expanded = await git(['ls-remote', '--get-url', remote], at);
    return keyForRemote(expanded.code === 0 ? expanded.stdout.trim() : remote);
  }

  async function clone(args: string[], effectiveCwd: string): Promise<number | undefined> {
    const parsed = parseClone(args);
    if (typeof parsed === 'string') return fallback(args, parsed);
    const key = await remoteKey(parsed.remote, effectiveCwd);
    const destination = resolve(effectiveCwd, parsed.destination ?? defaultCloneName(parsed.remote));
    if (!key) {
      fallback(args, 'remote is not a supported network URL');
      const result = await git(['clone', ...args], effectiveCwd, true);
      if (result.code === 0) await pinBorrower(destination);
      return result.code;
    }
    // Like Git, clone into a missing or empty directory.
    const entries = await readdir(destination).catch((error: NodeJS.ErrnoException) =>
      error.code === 'ENOENT' ? [] : undefined,
    );
    if (!entries || entries.length) return fallback(args, `${destination} is not an empty directory`);
    const root = await storePath();
    // Lock only the pool writes. Only store prune deletes pool objects, so git clone can
    // read the pool while other processes fetch or repack, and the new tips are pinned right after.
    let poolReused = false;
    let fetched: string | undefined;
    let fetchError: unknown;
    // Like git clone: progress on a terminal or with --progress, never with -q/--quiet.
    const quiet = parsed.forwarded.some((arg) => arg === '-q' || arg === '--quiet');
    const progress = !quiet && (process.stderr.isTTY || parsed.forwarded.includes('--progress'));
    // Until the pin lands, this clone borrows pool objects that nothing pins, so
    // store prune refuses while the marker exists. A failed pin leaves it behind.
    const marker = join(root, 'clones', `${randomUUID()}.json`);
    try {
      fetched = await withLock(root, async () => {
        poolReused = options.onStorageReport ? await isPresent(poolPath(root)) : false;
        const pool = await fetchRemote(root, parsed.remote, key, progress).catch((error: unknown) => {
          fetchError = error;
          return undefined;
        });
        if (pool) {
          await mkdir(dirname(marker), { recursive: true });
          await writeFile(marker, JSON.stringify({ pid: process.pid, destination }) + '\n');
        }
        return pool;
      });
    } catch {
      return fallback(args, 'object pool lock unavailable');
    }
    if (!fetched) return fallback(args, `object pool unavailable${gitFailure(fetchError)}`);
    const pool = fetched;
    const cloneArgs = ['clone', '--reference', pool, ...parsed.forwarded, parsed.remote, destination];
    const result = await git(cloneArgs, effectiveCwd, true);
    if (result.code !== 0) {
      if (!(await isPresent(join(destination, '.git')))) await rm(marker, { force: true });
      return result.code;
    }
    const commonGitdir = await repoCommonGitdir(destination);
    const tips = await consumerTips(destination);
    await withLock(root, async () => {
      await pinConsumer(pool, destination, commonGitdir, tips);
      await rm(marker, { force: true });
    });
    if (options.onStorageReport)
      emitStorageReport({ operation: 'clone', repository: destination, poolReused, estimatedSavedBytes: 0 });
    if (!parsed.recurse) return 0;
    // Like native clone, activate every submodule, including ones added upstream later.
    const active = await git(['config', 'submodule.active', '.'], destination, true);
    if (active.code !== 0) return active.code;
    return updateSubmodules(['update', '--init', '--recursive'], destination);
  }

  /** A local clone of a linked checkout copies its alternates and borrows from the pool; pin it like any clone. */
  async function pinBorrower(destination: string): Promise<void> {
    const root = await storePath();
    const pool = poolPath(root);
    // ponytail: destination comes from defaultCloneName; unusual local names such as `..` are not recognized.
    if (!(await isPresent(join(destination, '.git')))) return;
    const commonGitdir = await repoCommonGitdir(destination);
    const alternates = await readFile(join(commonGitdir, 'objects', 'info', 'alternates'), 'utf8').catch(() => '');
    if (!alternateLines(alternates).includes(join(pool, 'objects'))) return;
    // The source's pins hold these objects until this pin lands.
    const tips = await consumerTips(destination);
    await withLock(root, () => pinConsumer(pool, destination, commonGitdir, tips));
  }

  async function seedSubmodules(repo: string): Promise<void> {
    const modulesFile = join(repo, '.gitmodules');
    if (!(await isPresent(modulesFile))) return;
    const parentRemote = await origin(repo);
    const listing = await git(['config', '--file', modulesFile, '--get-regexp', '^submodule\\..*\\.(path|url)$'], repo);
    if (listing.code !== 0) return;
    const byName = new Map<string, { path?: string; url?: string }>();
    for (const line of listing.stdout.split('\n')) {
      const match = line.match(/^submodule\.(.+)\.(path|url) (.+)$/);
      if (!match) continue;
      const item = byName.get(match[1]!) ?? {};
      item[match[2]! as 'path' | 'url'] = match[3]!;
      byName.set(match[1]!, item);
    }
    for (const [name, item] of byName) {
      if (!item.path || !item.url || name.split('/').some((p) => !p || p === '.' || p === '..')) continue;
      const registered = await git(['config', '--get', `submodule.${name}.url`], repo);
      if (registered.code !== 0) continue;
      const active = await git(['config', '--type=bool', '--get', `submodule.${name}.active`], repo);
      if (active.stdout.trim() === 'false') continue;
      const remote = resolveSubmoduleRemote(parentRemote ?? '', registered.stdout.trim());
      const key = remote && (await remoteKey(remote, repo));
      if (!remote || !key) continue;
      const target = resolve(repo, item.path);
      // Leave populated paths (an initialized checkout or user files) to native Git, which refuses to clobber them.
      if (!target.startsWith(repo + sep) || (await readdir(target).catch(() => [])).length > 0) continue;
      const gitPathResult = await git(['rev-parse', '--path-format=absolute', '--git-path', `modules/${name}`], repo);
      if (gitPathResult.code !== 0) continue;
      const gitdir = gitPathResult.stdout.trim();
      if (await isPresent(gitdir)) continue;
      const root = await storePath();
      await withLock(root, async () => {
        const pool = await fetchRemote(root, remote, key);
        await mkdir(dirname(gitdir), { recursive: true });
        await checked(['clone', '--bare', '--reference', pool, remote, gitdir]);
        // Match a native submodule clone: remote-tracking refs, origin/HEAD, and only the default local branch.
        await checked(['--git-dir', gitdir, 'config', 'remote.origin.fetch', '+refs/heads/*:refs/remotes/origin/*']);
        await checked(['--git-dir', gitdir, 'fetch', '--quiet', 'origin']);
        const head = await git(['--git-dir', gitdir, 'symbolic-ref', '--short', '-q', 'HEAD']);
        const branch = head.code === 0 ? head.stdout.trim() : undefined;
        if (branch) {
          await checked(['--git-dir', gitdir, 'remote', 'set-head', 'origin', branch]);
          await checked(['--git-dir', gitdir, 'config', `branch.${branch}.remote`, 'origin']);
          await checked(['--git-dir', gitdir, 'config', `branch.${branch}.merge`, `refs/heads/${branch}`]);
        }
        const others = (await checked(['--git-dir', gitdir, 'for-each-ref', '--format=%(refname:short)', 'refs/heads']))
          .split('\n')
          .filter((ref) => ref && ref !== branch);
        if (others.length > 0) await checked(['--git-dir', gitdir, 'branch', '-D', ...others]);
        await checked(['--git-dir', gitdir, 'config', 'core.bare', 'false']);
        await checked(['--git-dir', gitdir, 'config', 'core.worktree', target]);
        await pinConsumer(pool, gitdir, gitdir, await consumerTips(gitdir));
      });
    }
  }

  async function updateSubmodules(args: string[], at: string): Promise<number> {
    if (args[0] === 'add') {
      const code = (await git(['submodule', ...args], at, true)).code;
      if (code !== 0) return code;
      const target = submoduleAddPath(args);
      if (!target) fallback(args, 'submodule path not recognized');
      else {
        try {
          await add(resolve(at, target));
        } catch (error) {
          process.stderr.write(`git-dedup: submodule adoption unavailable (${String(error)})\n`);
        }
      }
      return 0;
    }
    if (args[0] !== 'update') return (await git(['submodule', ...args], at, true)).code;
    // Without a pathspec, `git submodule update` from a subdirectory covers the whole superproject.
    const toplevel = await git(['rev-parse', '--show-toplevel'], at);
    const repo = toplevel.code === 0 ? toplevel.stdout.trim() : at;
    const unsupported = args.slice(1).find((arg) => !['--init', '--recursive', '--quiet', '-q'].includes(arg));
    if (unsupported) {
      fallback(args, `submodule update ${unsupported} is not supported`);
      return (await git(['submodule', ...args], at, true)).code;
    }
    // The native clone default '.' activates every submodule, which seeding already handles.
    const active = await git(['config', '--get-all', 'submodule.active'], at);
    if (active.code === 0 && active.stdout.trim() !== '.') {
      fallback(args, 'submodule.active is configured');
      return (await git(['submodule', ...args], at, true)).code;
    }
    if (args.includes('--init')) {
      const init = (await git(['submodule', 'init'], at, true)).code;
      if (init !== 0) return init;
    }
    try {
      await seedSubmodules(repo);
    } catch (error) {
      fallback(args, `submodule adoption unavailable${gitFailure(error)}`);
    }
    const recursive =
      args.includes('--recursive') &&
      args.includes('--init') &&
      !args.some((arg) => ['--remote', '--merge', '--rebase', '--force', '--checkout'].includes(arg));
    if (!recursive) return (await git(['submodule', ...args], at, true)).code;
    const top = (await git(['submodule', ...args.filter((arg) => arg !== '--recursive')], at, true)).code;
    if (top !== 0) return top;
    const listing = await git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], repo);
    if (listing.code !== 0) return 0;
    for (const line of listing.stdout.trim().split('\n')) {
      const match = line.match(/^submodule\..*\.path (.+)$/);
      if (!match) continue;
      const child = resolve(repo, match[1]!);
      if (!child.startsWith(repo + sep) || !(await isPresent(child))) continue;
      const nested = await updateSubmodules(['update', '--init', '--recursive'], child);
      if (nested !== 0) return nested;
    }
    return 0;
  }

  /** Visit the checkout of every initialized submodule gitdir under a modules directory. */
  async function visitModules(directory: string, visit: (repo: string) => Promise<void>): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const modulePath = join(directory, entry.name);
      if (await isPresent(join(modulePath, 'HEAD'))) {
        const workTree = (await git(['--git-dir', modulePath, 'config', '--get', 'core.worktree'])).stdout.trim();
        if (workTree) await visit(resolve(modulePath, workTree));
      } else await visitModules(modulePath, visit);
    }
  }

  async function add(path = cwd): Promise<StoreAddResult> {
    const result: StoreAddResult = { added: 0, skipped: 0, failed: 0, repositories: [] };
    const visited = new Set<string>();
    function record(
      repoPath: string,
      status: StoreAddRepositoryResult['status'],
      reason?: string,
      detail?: string,
    ): void {
      result[status]++;
      result.repositories.push({
        path: repoPath,
        status,
        ...(reason ? { reason } : {}),
        ...(detail ? { detail } : {}),
      });
    }
    async function adopt(repo: string): Promise<void> {
      let gitdir: string;
      try {
        gitdir = await repoGitdir(repo);
      } catch (error) {
        record(repo, 'skipped', 'not a Git repository or path is unavailable', String(error));
        return;
      }
      if (visited.has(gitdir)) {
        record(repo, 'skipped', 'object database already visited');
        return;
      }
      visited.add(gitdir);
      let stage = 'preparing repository';
      try {
        if ((await checked(['rev-parse', '--show-object-format'], repo)) !== 'sha1') {
          record(repo, 'skipped', 'unsupported object format (requires SHA-1)');
          return;
        }
        const commonGitdir = await repoCommonGitdir(repo);
        const url = await origin(repo);
        if (!url) {
          record(repo, 'skipped', 'no origin remote');
          return;
        }
        const key = await remoteKey(url, repo);
        if (!key) {
          record(repo, 'skipped', 'origin URL cannot be used as a store key');
          return;
        }
        const root = await storePath();
        await withLock(root, async () => {
          const poolReused = await isPresent(poolPath(root));
          const pool = await ensurePool(root);
          const tips = await consumerTips(repo);
          // A successful marker belongs to this worktree; linked worktrees can have different HEADs.
          const marker = join(gitdir, 'gitx-cache.json');
          const state = JSON.stringify({ version: 1, pool, remote: url, key, tips }) + '\n';
          const alternate = join(commonGitdir, 'objects', 'info', 'alternates');
          const originalAlternates = await readFile(alternate, 'utf8').catch(() => undefined);
          const alreadyLinked = alternateLines(originalAlternates ?? '').includes(join(pool, 'objects'));
          const registered =
            (await readFile(join(root, 'remotes', `${remoteId(key)}.json`), 'utf8').catch(() => '')) ===
            registration(url, key);
          const stateMatches =
            poolReused && alreadyLinked && registered && (await readFile(marker, 'utf8').catch(() => '')) === state;
          const id = await consumerId(root, commonGitdir);
          if (stateMatches && !(await unpinnedTips(pool, id, tips)).length) {
            // Checkouts adopted before the consumer registry existed register here.
            await registerConsumer(root, id, commonGitdir);
            record(repo, 'skipped', 'already current');
            process.stderr.write(`git-dedup: adding ${repo}: already current\n`);
            return;
          }
          process.stderr.write(`git-dedup: adding ${repo}: packing local objects\n`);
          // Gather loose local objects before adding an alternate; afterwards Git may
          // consider a local object redundant and omit it from a new pack.
          if (!alreadyLinked) await checked(['-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '-l'], repo);
          const beforeUniqueBytes = await uniquePackBytes(commonGitdir);
          process.stderr.write(`git-dedup: adding ${repo}: importing refs\n`);
          stage = 'importing refs';
          await pinConsumer(pool, repo, commonGitdir, tips);
          stage = 'sharing objects';
          process.stderr.write(`git-dedup: adding ${repo}: sharing objects\n`);
          try {
            await setAlternate(commonGitdir, pool);
            await removeLegacyKeeps(commonGitdir);
            await checked(['-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '-l'], repo);
          } catch (error) {
            // Restore only until this repack succeeds; afterwards objects it dropped live only in the pool.
            if (originalAlternates === undefined) await rm(alternate, { force: true });
            else await writeFile(alternate, originalAlternates);
            throw error;
          }
          if (
            (await isPresent(join(commonGitdir, 'objects', 'info', 'commit-graph'))) ||
            (await isPresent(join(commonGitdir, 'objects', 'info', 'commit-graphs')))
          )
            await checked(['commit-graph', 'write', '--reachable'], repo);
          await checked(['fsck', '--connectivity-only', '--no-reflogs'], repo);
          // Local adoption succeeds even when the remote is temporarily unavailable.
          await registerRemote(root, url, key);
          let refreshError: unknown;
          try {
            await fetchRemoteObjects(pool, url, key);
          } catch (error) {
            refreshError = error;
          }
          await writeFile(marker, state);
          if (options.onStorageReport) {
            const afterUniqueBytes = await uniquePackBytes(commonGitdir);
            emitStorageReport({
              operation: 'add',
              repository: repo,
              poolReused,
              beforeUniqueBytes,
              afterUniqueBytes,
              estimatedSavedBytes: Math.max(0, beforeUniqueBytes - afterUniqueBytes),
            });
          }
          record(
            repo,
            'added',
            refreshError ? 'remote refresh deferred; retry with git-dedup store fetch' : undefined,
            refreshError ? String(refreshError) : undefined,
          );
          if (refreshError)
            process.stderr.write(
              `git-dedup: adding ${repo}: remote refresh deferred; retry with git-dedup store fetch\n`,
            );
        });
      } catch (error) {
        record(repo, 'failed', addFailureReason(error, stage), String(error));
      } finally {
        await visitModules(join(gitdir, 'modules'), adopt);
      }
    }
    await adopt(resolve(cwd, path));
    return result;
  }

  async function remove(path = cwd): Promise<StoreRemoveResult> {
    const result: StoreRemoveResult = { removed: 0, skipped: 0, failed: 0, repositories: [] };
    const visited = new Set<string>();
    const root = await storePath();
    const pool = poolPath(root);
    const poolObjects = join(pool, 'objects');
    function record(entry: StoreRemoveRepositoryResult): void {
      result[entry.status]++;
      result.repositories.push(entry);
    }
    async function detach(repo: string): Promise<void> {
      let commonGitdir: string;
      try {
        commonGitdir = await repoCommonGitdir(repo);
      } catch (error) {
        const missing = !(await isPresent(repo));
        record({
          path: repo,
          status: missing ? 'failed' : 'skipped',
          reason: missing
            ? `path not found; if this checkout was deleted, run git-dedup store remove --forget ${repo}`
            : 'not a Git repository or path is unavailable',
          detail: String(error),
        });
        return;
      }
      // Linked worktrees share one object database, so detach it once.
      if (visited.has(commonGitdir)) return;
      visited.add(commonGitdir);
      const gitdirs = [
        commonGitdir,
        ...(await readdir(join(commonGitdir, 'worktrees')).catch(() => [])).map((name) =>
          join(commonGitdir, 'worktrees', name),
        ),
      ];
      const alternate = join(commonGitdir, 'objects', 'info', 'alternates');
      try {
        const original = await readFile(alternate, 'utf8').catch(() => '');
        const lines = alternateLines(original);
        if (!lines.includes(poolObjects)) {
          record({ path: repo, status: 'skipped', reason: 'not linked to the store' });
          return;
        }
        if (!(await isPresent(pool))) throw new Error(`Object pool is missing: ${pool}`);
        // Lock without initializing: removal must never create a store.
        await lockDirectory(storeLock(root), async () => {
          process.stderr.write(`git-dedup: removing ${repo}: copying shared objects\n`);
          // Repack and fsck ignore in-progress merge, cherry-pick, and rebase state, so pin the
          // objects it names with temporary refs. Names that are already missing stay missing.
          const named = new Set<string>();
          for (const gitdir of gitdirs) for (const oid of await stateOids(gitdir)) named.add(oid);
          const present = named.size
            ? (await checked(['cat-file', '--batch-check=%(objectname)'], repo, false, [...named].join('\n') + '\n'))
                .split('\n')
                .filter((line) => /^[0-9a-f]{40}$/.test(line))
            : [];
          try {
            if (present.length)
              await checked(
                ['update-ref', '--stdin'],
                repo,
                false,
                present.map((oid) => `update refs/gitx-detach/${oid} ${oid}\n`).join(''),
              );
            // Without -l, repack copies every object reachable from refs, reflogs, and
            // the indexes of all worktrees, including objects read through the pool.
            await checked(['-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '--pack-kept-objects'], repo);
            const remaining = lines.filter((line) => line !== poolObjects);
            if (remaining.length) await writeFile(alternate, remaining.join('\n') + '\n');
            else await rm(alternate);
            try {
              await checked(['fsck', '--connectivity-only'], repo);
            } catch (error) {
              await writeFile(alternate, original);
              throw error;
            }
          } finally {
            if (present.length)
              await checked(
                ['update-ref', '--stdin'],
                repo,
                false,
                present.map((oid) => `delete refs/gitx-detach/${oid}\n`).join(''),
              );
          }
          const id = (await readFile(join(commonGitdir, 'gitx-consumer-id'), 'utf8').catch(() => '')).trim();
          // A copy carrying another live checkout's ID detaches without releasing that checkout's pins.
          if (/^[a-f0-9-]{36}$/.test(id) && !(await ownedElsewhere(root, id, commonGitdir))) {
            const pins = await checked([
              '-C',
              pool,
              'for-each-ref',
              '--format=delete %(refname)',
              `refs/gitx/consumers/${id}`,
            ]);
            if (pins) await checked(['-C', pool, 'update-ref', '--stdin'], cwd, false, pins + '\n');
            await rm(join(root, 'consumers', `${id}.json`), { force: true });
          }
          await rm(join(commonGitdir, 'gitx-consumer-id'), { force: true });
          for (const gitdir of gitdirs) await rm(join(gitdir, 'gitx-cache.json'), { force: true });
        });
        record({ path: repo, status: 'removed', objectBytes: await directorySize(join(commonGitdir, 'objects')) });
      } catch (error) {
        record({ path: repo, status: 'failed', reason: 'could not detach from the store', detail: String(error) });
      } finally {
        for (const gitdir of gitdirs) await visitModules(join(gitdir, 'modules'), detach);
      }
    }
    await detach(resolve(cwd, path));
    return result;
  }

  async function storeInfo(): Promise<StoreInfo> {
    const path = await storePath();
    return {
      path,
      sizeBytes: await directorySize(path),
      remoteCount: (await readdir(join(path, 'remotes')).catch(() => [])).filter((name) => name.endsWith('.json'))
        .length,
    };
  }

  async function listRemotes(): Promise<StoreRemote[]> {
    const directory = join(await storePath(), 'remotes');
    const entries = await readdir(directory).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return [];
      throw error;
    });
    const remotes = await Promise.all(
      entries
        .filter((name) => name.endsWith('.json'))
        .map(async (name): Promise<StoreRemote> => {
          const value: unknown = JSON.parse(await readFile(join(directory, name), 'utf8'));
          if (
            !value ||
            typeof value !== 'object' ||
            !('key' in value) ||
            typeof value.key !== 'string' ||
            !('remote' in value) ||
            typeof value.remote !== 'string' ||
            `${remoteId(value.key)}.json` !== name
          )
            throw new Error(`Invalid git-dedup remote registration: ${name}`);
          return { key: value.key, remote: redactRemote(value.remote, '***') };
        }),
    );
    return remotes.toSorted((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  async function fetch(): Promise<StoreFetchResult> {
    const root = await storePath();
    const remotes: StoreFetchRemoteResult[] = [];
    await withLock(root, async () => {
      for (const name of await readdir(join(root, 'remotes')).catch(() => [])) {
        if (!name.endsWith('.json')) continue;
        const { key, remote } = JSON.parse(await readFile(join(root, 'remotes', name), 'utf8')) as {
          key: string;
          remote: string;
        };
        try {
          await fetchRemote(root, remote, key);
          remotes.push({ key, status: 'fetched' });
        } catch (error) {
          const detail = String(error);
          const reason = /fatal: (.+)/.exec(detail)?.[1] ?? 'remote fetch failed';
          remotes.push({ key, status: 'failed', reason, detail });
        }
      }
      if (remotes.some((result) => result.status === 'fetched'))
        await checked(['-C', poolPath(root), 'repack', '-d', '--geometric=2']);
    });
    const fetched = remotes.filter((result) => result.status === 'fetched').length;
    return { fetched, failed: remotes.length - fetched, remotes };
  }

  async function gc(): Promise<{ compacted: boolean }> {
    const root = await storePath();
    if (!(await isPresent(poolPath(root)))) return { compacted: false };
    await withLock(root, async () => {
      await checked(['-C', poolPath(root), 'gc', '--prune=never']);
    });
    return { compacted: true };
  }

  /** Every object a consumer may borrow from the pool without a pin. */
  async function liveTips(commonGitdir: string): Promise<string[]> {
    if (
      (await git(['--git-dir', commonGitdir, 'config', '--get', 'extensions.refStorage'], commonGitdir)).stdout.trim()
    )
      throw new Error(`Refusing to prune: ${commonGitdir} uses a ref storage format that git-dedup cannot inspect`);
    const tips = new Set<string>();
    const extra = new Set<string>();
    const worktrees = (await readdir(join(commonGitdir, 'worktrees')).catch(() => [])).map((name) =>
      join(commonGitdir, 'worktrees', name),
    );
    for (const gitdir of [commonGitdir, ...worktrees]) {
      // Per-worktree refs and HEAD, then the index: git add skips blobs the pool already has.
      for (const oid of (await checked(['--git-dir', gitdir, 'for-each-ref', '--format=%(objectname)'], gitdir)).split(
        '\n',
      ))
        if (oid) tips.add(oid);
      const head = await git(['--git-dir', gitdir, 'rev-parse', '--verify', '-q', 'HEAD'], gitdir);
      if (head.code === 0) tips.add(head.stdout.trim());
      if (await isPresent(join(gitdir, 'index'))) {
        const tree = await git(['--git-dir', gitdir, 'write-tree'], gitdir);
        if (tree.code !== 0)
          throw new Error(`Refusing to prune: cannot record the index of ${gitdir}: ${tree.stderr.trim()}`);
        // Git always has the empty tree, so it needs no pin.
        if (tree.stdout.trim() !== '4b825dc642cb6eb9a060e54bf8d69288fbee4904') tips.add(tree.stdout.trim());
      }
      for (const oid of await stateOids(gitdir)) if (!tips.has(oid)) extra.add(oid);
    }
    // rev-list peels annotated tags to commits, so pin state-file tags (and other non-commits) directly.
    if (extra.size)
      for (const line of (
        await checked(
          ['--git-dir', commonGitdir, 'cat-file', '--batch-check=%(objectname) %(objecttype)'],
          commonGitdir,
          false,
          [...extra].join('\n') + '\n',
        )
      ).split('\n')) {
        const [oid, type] = line.split(' ');
        if (type && type !== 'commit' && type !== 'missing') tips.add(oid!);
      }
    // Commits held only by reflogs or state files; pin the tips of each abandoned history.
    const abandoned = await checked(
      ['--git-dir', commonGitdir, 'rev-list', '--parents', '--ignore-missing', '--reflog', ...extra, '--not', '--all'],
      commonGitdir,
    );
    const commits = new Set<string>();
    const parents = new Set<string>();
    for (const line of abandoned.split('\n').filter(Boolean)) {
      const [commit, ...rest] = line.split(' ');
      commits.add(commit!);
      for (const parent of rest) parents.add(parent);
    }
    for (const commit of commits) if (!parents.has(commit)) tips.add(commit);
    return [...tips].toSorted();
  }

  async function prune(): Promise<PruneResult> {
    const root = await storePath();
    const pool = poolPath(root);
    if (!(await isPresent(pool))) return { reclaimedBytes: 0 };
    return withLock(root, async () => {
      const registry = await registeredConsumers(root);
      // A clone between its pool fetch and its pin borrows objects that nothing pins yet.
      for (const name of await readdir(join(root, 'clones')).catch(() => [])) {
        const { pid, destination } = JSON.parse(await readFile(join(root, 'clones', name), 'utf8')) as {
          pid: number;
          destination: string;
        };
        if (processExists(pid))
          throw new Error(`Refusing to prune: a clone into ${destination} is in progress; retry when it finishes.`);
        const id = (await readFile(join(destination, '.git', 'gitx-consumer-id'), 'utf8').catch(() => '')).trim();
        if ((await isPresent(join(destination, '.git'))) && !registry.has(id))
          throw new Error(
            `Refusing to prune: the clone into ${destination} was never registered. ` +
              `Run git-dedup store add ${destination}, or delete that checkout, then retry.`,
          );
        await rm(join(root, 'clones', name));
      }
      const pinned = new Set(
        (await checked(['-C', pool, 'for-each-ref', '--format=%(refname)', 'refs/gitx/consumers']))
          .split('\n')
          .filter(Boolean)
          .map((ref) => ref.split('/')[3]!),
      );
      const unregistered = [...pinned].filter((id) => !registry.has(id));
      if (unregistered.length)
        throw new Error(
          `Refusing to prune: the pool holds objects for ${unregistered.length} unregistered checkout(s). ` +
            'Run git-dedup store add for every checkout that uses this store (for example ' +
            'git-dedup store add --all <directory>), then retry.',
        );
      // A moved checkout still borrows through its absolute alternate path, including
      // objects fetched after its last pin. Only the user can say it was deleted.
      const missing: string[] = [];
      for (const [id, gitdir] of registry) if (!(await carriesConsumerId(gitdir, id))) missing.push(gitdir);
      if (missing.length)
        throw new Error(
          `Refusing to prune: ${missing.length} registered checkout(s) cannot be found:\n` +
            missing.map((gitdir) => `  ${checkoutPath(gitdir)}\n`).join('') +
            'If this checkout was moved, run git-dedup store add <new path>. ' +
            'If it was deleted, run git-dedup store remove --forget <old path>.',
        );
      for (const gitdir of registry.values()) await pinConsumer(pool, gitdir, gitdir, await liveTips(gitdir));
      const before = await directorySize(pool);
      // Explicit expiry: the pool never prunes automatically.
      await checked(['-C', pool, 'gc', '--prune=now']);
      return { reclaimedBytes: Math.max(0, before - (await directorySize(pool))) };
    });
  }

  /** Release a registered checkout that no longer exists. Returns the Git directories forgotten. */
  async function forget(path: string): Promise<string[]> {
    const root = await storePath();
    const target = resolve(cwd, path);
    const candidates = new Set<string>();
    for (const base of [target, await canonicalPath(target)]) candidates.add(base).add(join(base, '.git'));
    if (!(await isPresent(root))) return [];
    return lockDirectory(storeLock(root), async () => {
      const forgotten: string[] = [];
      let present = false;
      for (const [id, gitdir] of await registeredConsumers(root)) {
        if (!candidates.has(gitdir)) continue;
        // A new checkout at a deleted checkout's path is live; forget only the old registration.
        if (await carriesConsumerId(gitdir, id)) {
          present = true;
          continue;
        }
        if (await isPresent(poolPath(root))) {
          const pins = await checked([
            '-C',
            poolPath(root),
            'for-each-ref',
            '--format=delete %(refname)',
            `refs/gitx/consumers/${id}`,
          ]);
          if (pins) await checked(['-C', poolPath(root), 'update-ref', '--stdin'], cwd, false, pins + '\n');
        }
        await rm(join(root, 'consumers', `${id}.json`));
        forgotten.push(gitdir);
      }
      if (!forgotten.length && present)
        throw new Error(`${path} still exists; run git-dedup store remove without --forget to detach it`);
      return forgotten;
    });
  }

  async function doctor(): Promise<DoctorResult> {
    const root = await storePath();
    const checks: DoctorCheck[] = [];
    const pool = poolPath(root);
    const empty = !(await isPresent(pool));
    if (!empty) {
      try {
        const format = await checked(['-C', pool, 'rev-parse', '--show-object-format']);
        const bare = await checked(['-C', pool, 'rev-parse', '--is-bare-repository']);
        checks.push({
          name: 'pool',
          ok: format === 'sha1' && bare === 'true',
          detail: `${pool}: ${format === 'sha1' ? 'SHA-1' : format.toUpperCase()} ${bare === 'true' ? 'bare' : 'non-bare'} object database`,
        });
      } catch (error) {
        checks.push({
          name: 'pool',
          ok: false,
          detail: `${pool}: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
    try {
      const binary = await gitPath();
      checks.push({ name: 'git', ok: true, detail: `${binary}: ${await checked(['--version'])}` });
    } catch (error) {
      checks.push({ name: 'git', ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    return { empty, checks };
  }

  async function addWorktree(args: string[], at: string): Promise<number> {
    if (args[0] !== 'add') return (await git(['worktree', ...args], at, true)).code;
    let path: string | undefined;
    let noCheckout = false;
    for (let i = 1; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === '--') {
        path = args[i + 1];
        break;
      }
      if (['-b', '-B', '--reason'].includes(arg)) {
        i++;
        continue;
      }
      if (arg === '--no-checkout' || arg === '--orphan') noCheckout = true;
      if (
        [
          '-f',
          '--force',
          '-d',
          '--detach',
          '--checkout',
          '--no-checkout',
          '--lock',
          '--track',
          '--no-track',
          '--guess-remote',
          '--no-guess-remote',
          '--orphan',
          '-q',
          '--quiet',
        ].includes(arg) ||
        /^(--reason|--track)=/.test(arg)
      )
        continue;
      if (arg.startsWith('-')) {
        fallback(args, `worktree add ${arg.split('=')[0]} is not supported`);
        return (await git(['worktree', ...args], at, true)).code;
      }
      path = arg;
      break;
    }
    const code = (await git(['worktree', ...args], at, true)).code;
    if (code !== 0 || !path || noCheckout) return code;
    const target = resolve(at, path);
    // Git already shares the superproject object directory between worktrees.
    // Its submodules have separate gitdirs, so populate those through the pool.
    if (await isPresent(join(target, '.gitmodules')))
      return updateSubmodules(['update', '--init', '--recursive'], target);
    return 0;
  }

  async function run(args: string[]): Promise<number> {
    const parsed = parseGlobal(args, cwd);
    if (incomingEnv.GITX_ACTIVE === '1' || incomingEnv.GIT_DEDUP_ACTIVE === '1' || !parsed)
      return (await git(args, cwd, true)).code;
    const managed =
      parsed.command === 'clone' ||
      (parsed.command === 'submodule' && ['add', 'update'].includes(parsed.rest[0]!)) ||
      (parsed.command === 'worktree' && parsed.rest[0] === 'add');
    if (hasRepositoryEnvironment) {
      if (managed) fallback(parsed.rest, 'Git repository environment variables are set');
      return (await git(args, cwd, true)).code;
    }
    // -C is resolved explicitly. Other global options can change Git semantics, so forward intact.
    for (let i = 0; i < parsed.prefix.length; i++) {
      const arg = parsed.prefix[i]!;
      if (arg === '-C') {
        i++;
        continue;
      }
      if (managed) fallback(parsed.rest, `global option ${arg.split('=')[0]} is not supported`);
      return (await git(args, cwd, true)).code;
    }
    if (parsed.cwd !== cwd) {
      return createGitDedup({ ...options, cwd: parsed.cwd, env: incomingEnv }).run([parsed.command, ...parsed.rest]);
    }
    if (parsed.command === 'clone') {
      const handled = await clone(parsed.rest, parsed.cwd);
      if (handled !== undefined) return handled;
    }
    if (parsed.command === 'submodule') return updateSubmodules(parsed.rest, parsed.cwd);
    if (parsed.command === 'worktree') return addWorktree(parsed.rest, parsed.cwd);
    return (await git(args, cwd, true)).code;
  }

  /** The underlying Git version line, such as `git version 2.50.1`. */
  async function gitVersion(): Promise<string> {
    const result = await git(['--version']);
    if (result.code !== 0) throw new Error(`git --version failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  return { run, add, remove, storeInfo, listRemotes, fetch, gc, prune, forget, doctor, storePath, gitVersion, gitPath };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export { keyForRemote };
