import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { constants } from 'node:fs';
import {
  access,
  copyFile,
  link,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir, constants as osConstants } from 'node:os';
import { basename, delimiter, dirname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { GitPluginError, simpleGit } from 'simple-git';

export interface GitxOptions {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  gitPath?: string;
  onStorageReport?: (report: StorageReport) => void;
}
export interface StorageReport {
  operation: 'clone' | 'cache';
  repository: string;
  mirrorReused: boolean;
  sharedPackBytes: number;
  copiedPackBytes: number;
  estimatedSavedBytes: number;
  /** Logical bytes in private pack files before/after cache adoption. Loose objects are excluded. */
  beforeUniqueBytes?: number;
  afterUniqueBytes?: number;
}
export interface StoreInfo {
  path: string;
  sizeBytes: number;
  mirrorCount: number;
}
export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
}
export interface DoctorResult {
  checks: DoctorCheck[];
}
export interface CacheResult {
  cached: number;
  skipped: number;
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
  let pathname: string;
  if (/^[^/@:]+@[^/:]+:.+/.test(remote)) {
    const match = remote.match(/^[^/@:]+@([^/:]+):(.+)$/)!;
    host = match[1]!;
    pathname = match[2]!;
  } else {
    let url: URL;
    try {
      url = new URL(remote);
    } catch {
      return undefined;
    }
    if (!['https:', 'http:', 'ssh:', 'git:'].includes(url.protocol)) return undefined;
    host = url.hostname + (url.port ? `_${url.port}` : '');
    pathname = url.pathname;
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
  return `${host.toLowerCase()}/${parts.join('/')}`;
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

async function findMirrors(path: string): Promise<string[]> {
  const result: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
      if (!entry.isDirectory()) continue;
      const child = join(directory, entry.name);
      if (entry.name.endsWith('.git') && (await isPresent(join(child, 'HEAD')))) result.push(child);
      else await walk(child);
    }
  }
  await walk(path);
  return result;
}

function unsupportedClone(args: string[]): boolean {
  return args.some((arg) =>
    /^(--depth|--shallow|--filter|--mirror|--bare|--reference|--dissociate|--no-hardlinks|--shared|--separate-git-dir|--bundle-uri|--sparse|--upload-pack|--server-option|--template|--config|--origin|--no-checkout|--single-branch|--no-single-branch|--revision|--jobs|-j|-o|-u|-c)(=|$)/.test(
      arg,
    ),
  );
}

function parseClone(
  args: string[],
): { remote: string; destination?: string; recurse: boolean; branch?: string; forwarded: string[] } | undefined {
  if (unsupportedClone(args)) return undefined;
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
      if (!branch) return undefined;
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
    if (arg.startsWith('-')) return undefined;
    positional.push(arg);
  }
  if (positional.length < 1 || positional.length > 2) return undefined;
  return { remote: positional[0]!, destination: positional[1], recurse, branch, forwarded };
}

function defaultCloneName(remote: string): string {
  return remote
    .replace(/\/+$/, '')
    .split(/[/:]/)
    .at(-1)!
    .replace(/\.git$/, '');
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
    if (arg.startsWith('-C') && arg.length > 2) {
      prefix.push(arg);
      cwd = resolve(cwd, arg.slice(2));
      i++;
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

async function lockDirectory<T>(lock: string, action: () => Promise<T>): Promise<T> {
  await mkdir(dirname(lock), { recursive: true });
  for (let attempts = 0; ; attempts++) {
    try {
      await mkdir(lock);
      await writeFile(join(lock, 'owner'), `${process.pid}\n`);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (attempts > 1200) throw new Error(`Timed out waiting for gitx lock: ${lock}`, { cause: error });
      const owner = Number((await readFile(join(lock, 'owner'), 'utf8').catch(() => '')).trim());
      const age = Date.now() - (await stat(lock).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs;
      // A dead owner may be reaped. A live but slow Git process must never lose its lock.
      if (age > 5000 && owner && !processExists(owner)) {
        await rm(lock, { recursive: true, force: true });
        continue;
      }
      await delay(50);
    }
  }
  try {
    return await action();
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}

function storeLock(root: string): string {
  return join(dirname(root), `.${basename(root)}.gitx-lock`);
}

async function initializeStore(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const marker = join(root, '.gitx-store');
  if (await isPresent(marker)) {
    if ((await readFile(marker, 'utf8')) !== 'gitx-store-v1\n') throw new Error(`Invalid gitx store marker: ${root}`);
    return;
  }
  if ((await readdir(root)).length) throw new Error(`Refusing to adopt a nonempty directory as a store: ${root}`);
  await writeFile(marker, 'gitx-store-v1\n', { flag: 'wx' });
}

async function markLinkedPacks(
  mirror: string,
  consumerGitdir: string,
  mode: 'auto' | 'hardlink' | 'copy' | 'reflink' = 'auto',
): Promise<void> {
  const source = join(mirror, 'objects', 'pack');
  const target = join(consumerGitdir, 'objects', 'pack');
  for (const name of await readdir(target).catch(() => [])) {
    if (!name.endsWith('.pack')) continue;
    const a = await stat(join(source, name)).catch(() => undefined);
    const b = await stat(join(target, name)).catch(() => undefined);
    if (a && b && (mode === 'copy' || mode === 'reflink' || (a.dev === b.dev && a.ino === b.ino)))
      await writeFile(join(target, name.replace(/\.pack$/, '.keep')), 'gitx base pack\n');
  }
}

async function packReport(
  mirror: string,
  consumerGitdir: string,
): Promise<{ sharedPackBytes: number; copiedPackBytes: number }> {
  const source = join(mirror, 'objects', 'pack');
  const target = join(consumerGitdir, 'objects', 'pack');
  let sharedPackBytes = 0;
  let copiedPackBytes = 0;
  for (const name of await readdir(source).catch(() => [])) {
    if (!/\.(pack|idx|rev)$/.test(name)) continue;
    const [a, b] = await Promise.all([
      stat(join(source, name)).catch(() => undefined),
      stat(join(target, name)).catch(() => undefined),
    ]);
    if (!a || !b) continue;
    if (a.dev === b.dev && a.ino === b.ino) sharedPackBytes += b.size;
    else copiedPackBytes += b.size;
  }
  return { sharedPackBytes, copiedPackBytes };
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

async function reflinkPacks(mirror: string, consumerGitdir: string): Promise<void> {
  const source = join(mirror, 'objects', 'pack');
  const target = join(consumerGitdir, 'objects', 'pack');
  for (const name of await readdir(source).catch(() => [])) {
    if (!/\.(pack|idx|rev)$/.test(name) || !(await isPresent(join(target, name)))) continue;
    const temp = join(target, `${name}.gitx-${process.pid}`);
    try {
      await copyFile(join(source, name), temp, constants.COPYFILE_FICLONE_FORCE).catch(() =>
        copyFile(join(source, name), temp),
      );
      await rename(temp, join(target, name));
    } finally {
      await rm(temp, { force: true });
    }
  }
}

async function withLock<T>(root: string, key: string, action: () => Promise<T>): Promise<T> {
  // Keep the maintenance lock beside the store, so clear cannot delete an active lock.
  // Serialize mutations in v1, including across keys; consumers remain independent.
  return lockDirectory(storeLock(root), async () => {
    await initializeStore(root);
    const lock = join(root, 'locks', createHash('sha256').update(key).digest('hex') + '.lock');
    return lockDirectory(lock, action);
  });
}

export function createGitx(options: GitxOptions = {}) {
  const cwd = resolve(options.cwd ?? process.cwd());
  const incomingEnv: NodeJS.ProcessEnv = { ...process.env, ...options.env };
  const env: NodeJS.ProcessEnv = { ...incomingEnv, GITX_ACTIVE: '1' };
  let cachedGit: string | undefined;
  function emitStorageReport(report: StorageReport): void {
    try {
      options.onStorageReport?.(report);
    } catch {
      process.stderr.write('gitx: storage report callback failed\n');
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
      const configured = await promisify(execFile)(candidate, ['config', '--get', 'gitx.gitPath'], { cwd, env }).then(
        (result) => result.stdout.trim(),
        () => '',
      );
      if (configured) candidate = resolve(cwd, expandHome(configured));
    }
    const actual = await realpath(candidate).catch(() => '');
    if (!actual || actual === own) throw new Error('gitx.gitPath must point to a real Git executable, not gitx itself');
    await access(candidate, constants.X_OK);
    return (cachedGit = candidate);
  }

  async function git(args: string[], at = cwd, inherit = false): Promise<GitResult> {
    const binary = await gitPath();
    return new Promise((resolveResult, reject) => {
      const child = spawn(binary, args, { cwd: at, env, stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'] });
      let stdout = '';
      let stderr = '';
      if (!inherit) {
        child.stdout?.on('data', (b) => {
          stdout += b;
        });
        child.stderr?.on('data', (b) => {
          stderr += b;
        });
      }
      const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
      const handlers = signals.map((signal) => () => {
        child.kill(signal);
      });
      const cleanup = () => {
        if (inherit) signals.forEach((signal, i) => process.removeListener(signal, handlers[i]!));
      };
      if (inherit) signals.forEach((signal, i) => process.on(signal, handlers[i]!));
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

  async function checked(args: string[], at = cwd): Promise<string> {
    if (hasRepositoryEnvironment)
      throw new Error('Unset Git repository override environment variables before running gitx storage operations');
    const result = await git(args, at);
    if (result.code !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr.trim()}`);
    return result.stdout.trim();
  }

  async function config(name: string): Promise<string | undefined> {
    const result = await git(['config', '--get', name]);
    return result.code === 0 ? result.stdout.trim() : undefined;
  }

  async function storePath(): Promise<string> {
    return canonicalPath(resolve(cwd, expandHome(env.GITX_STORE || '~/.cache/gitx')));
  }

  async function linkMode(): Promise<'auto' | 'hardlink' | 'copy' | 'reflink'> {
    const value = (await config('gitx.linkMode')) || 'auto';
    if (!['auto', 'hardlink', 'copy', 'reflink'].includes(value)) throw new Error(`Invalid gitx.linkMode: ${value}`);
    return value as 'auto' | 'hardlink' | 'copy' | 'reflink';
  }

  async function ensureMirror(remote: string, key: string, root: string): Promise<string> {
    const mirror = join(root, 'mirrors', `${key}.git`);
    await mkdir(dirname(mirror), { recursive: true });
    await mkdir(join(root, 'tmp'), { recursive: true });
    if (!(await isPresent(mirror))) {
      const staging = join(
        root,
        'tmp',
        createHash('sha256').update(key).digest('hex') + `-${process.pid}-${Date.now()}.git`,
      );
      try {
        const clientEnv = { ...env };
        delete clientEnv.PAGER;
        delete clientEnv.GIT_PAGER;
        const client = simpleGit({
          baseDir: cwd,
          binary: await gitPath(),
          maxConcurrentProcesses: 1,
          unsafe: { allowUnsafeConfigPaths: true },
          allowEnvironment: Object.keys(clientEnv),
        });
        try {
          await client.env(clientEnv).clone(remote, staging, ['--bare']);
        } catch (error) {
          if (!(error instanceof GitPluginError) || !['unsafe', 'allowEnvironment'].includes(error.plugin ?? ''))
            throw error;
          // Library policy can reject ordinary caller settings such as EDITOR or
          // GIT_SSH_COMMAND before spawning Git. This local Git wrapper already
          // honors that same environment for every other operation. Run the
          // mirror clone through our native adapter; keep transport errors intact.
          await checked(['clone', '--bare', '--', remote, staging]);
        }
        if ((await checked(['-C', staging, 'rev-parse', '--show-object-format'])) !== 'sha1')
          throw new Error('Unsupported Git object format');
        await rename(staging, mirror);
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    } else {
      if ((await checked(['-C', mirror, 'rev-parse', '--show-object-format'])) !== 'sha1')
        throw new Error('Unsupported Git object format');
      await checked(['-C', mirror, 'remote', 'set-url', 'origin', remote]);
      await checked([
        '-C',
        mirror,
        'fetch',
        '--prune',
        'origin',
        '+refs/heads/*:refs/heads/*',
        '+refs/tags/*:refs/tags/*',
      ]);
      const head = await git(['-C', mirror, 'ls-remote', '--symref', 'origin', 'HEAD']);
      const branch = head.stdout.match(/^ref: (refs\/heads\/[^\s]+)\s+HEAD/m)?.[1];
      if (head.code === 0 && branch) await checked(['-C', mirror, 'symbolic-ref', 'HEAD', branch]);
    }
    const stamp = join(mirror, '.gitx-last-used');
    await writeFile(stamp, '');
    return mirror;
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
    if (!parsed) return undefined;
    const key = await remoteKey(parsed.remote, effectiveCwd);
    if (!key) return undefined;
    const destination = resolve(effectiveCwd, parsed.destination ?? defaultCloneName(parsed.remote));
    if (await isPresent(destination)) return undefined;
    const root = await storePath();
    const cloned = await withLock(root, key, async () => {
      const mirrorReused = options.onStorageReport ? await isPresent(join(root, 'mirrors', `${key}.git`)) : false;
      let mirror: string;
      try {
        mirror = await ensureMirror(parsed.remote, key, root);
      } catch {
        process.stderr.write('gitx: mirror unavailable; using Git clone\n');
        return undefined;
      }
      const mode = await linkMode();
      const cloneArgs = [
        'clone',
        ...parsed.forwarded,
        ...(mode === 'copy' || mode === 'reflink' ? ['--no-hardlinks'] : []),
        mirror,
        destination,
      ];
      const result = await git(cloneArgs, effectiveCwd, true);
      if (result.code !== 0) return result.code;
      try {
        await checked(['remote', 'set-url', 'origin', parsed.remote], destination);
        await checked(['fetch', 'origin'], destination);
        const gitdir = await repoGitdir(destination);
        if (mode === 'reflink') await reflinkPacks(mirror, gitdir);
        await markLinkedPacks(mirror, gitdir, mode);
        if (options.onStorageReport) {
          const bytes = await packReport(mirror, gitdir);
          emitStorageReport({
            operation: 'clone',
            repository: destination,
            mirrorReused,
            ...bytes,
            estimatedSavedBytes: bytes.sharedPackBytes,
          });
        }
      } catch (error) {
        // The clone remains a valid standalone repository even if housekeeping fails.
        process.stderr.write(`gitx: ${String(error)}\n`);
      }
      return 0;
    });
    if (cloned === 0 && parsed.recurse) return updateSubmodules(['update', '--init', '--recursive'], destination);
    return cloned;
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
      if (!target.startsWith(repo + sep) || (await isPresent(join(target, '.git')))) continue;
      const gitPathResult = await git(['rev-parse', '--path-format=absolute', '--git-path', `modules/${name}`], repo);
      if (gitPathResult.code !== 0) continue;
      const gitdir = gitPathResult.stdout.trim();
      if (await isPresent(gitdir)) continue;
      const root = await storePath();
      await withLock(root, key, async () => {
        const mirror = await ensureMirror(remote, key, root);
        const mode = await linkMode();
        await mkdir(dirname(gitdir), { recursive: true });
        await checked([
          'clone',
          '--bare',
          ...(mode === 'copy' || mode === 'reflink' ? ['--no-hardlinks'] : []),
          mirror,
          gitdir,
        ]);
        await checked(['-C', gitdir, 'remote', 'set-url', 'origin', remote]);
        await checked(['--git-dir', gitdir, 'config', 'core.bare', 'false']);
        await checked(['--git-dir', gitdir, 'config', 'core.worktree', target]);
        if (mode === 'reflink') await reflinkPacks(mirror, gitdir);
        await markLinkedPacks(mirror, gitdir, mode);
      });
    }
  }

  async function updateSubmodules(args: string[], at: string): Promise<number> {
    if (args[0] === 'add') {
      const code = (await git(['submodule', ...args], at, true)).code;
      if (code !== 0) return code;
      const target = args.length === 2 ? defaultCloneName(args[1]!) : args.length === 3 ? args[2] : undefined;
      if (target && !target.startsWith('-')) {
        try {
          await cache(resolve(at, target));
        } catch (error) {
          process.stderr.write(`gitx: submodule cache unavailable (${String(error)})\n`);
        }
      }
      return 0;
    }
    if (args[0] !== 'update' || args.slice(1).some((arg) => !['--init', '--recursive', '--quiet', '-q'].includes(arg)))
      return (await git(['submodule', ...args], at, true)).code;
    if ((await git(['config', '--get', 'submodule.active'], at)).code === 0)
      return (await git(['submodule', ...args], at, true)).code;
    if (args.includes('--init')) {
      const init = (await git(['submodule', 'init'], at, true)).code;
      if (init !== 0) return init;
    }
    try {
      await seedSubmodules(at);
    } catch {
      process.stderr.write('gitx: submodule cache unavailable; using Git\n');
    }
    const recursive =
      args.includes('--recursive') &&
      args.includes('--init') &&
      !args.some((arg) => ['--remote', '--merge', '--rebase', '--force', '--checkout'].includes(arg));
    if (!recursive) return (await git(['submodule', ...args], at, true)).code;
    const top = (await git(['submodule', ...args.filter((arg) => arg !== '--recursive')], at, true)).code;
    if (top !== 0) return top;
    const listing = await git(['config', '--file', '.gitmodules', '--get-regexp', '^submodule\\..*\\.path$'], at);
    if (listing.code !== 0) return 0;
    for (const line of listing.stdout.trim().split('\n')) {
      const match = line.match(/^submodule\..*\.path (.+)$/);
      if (!match) continue;
      const child = resolve(at, match[1]!);
      if (!child.startsWith(at + sep) || !(await isPresent(child))) continue;
      const nested = await updateSubmodules(['update', '--init', '--recursive'], child);
      if (nested !== 0) return nested;
    }
    return 0;
  }

  async function cache(path = cwd): Promise<CacheResult> {
    const result: CacheResult = { cached: 0, skipped: 0 };
    const visited = new Set<string>();
    async function adopt(repo: string): Promise<void> {
      const gitdir = await repoGitdir(repo).catch(() => undefined);
      if (!gitdir || visited.has(gitdir)) {
        result.skipped++;
        return;
      }
      visited.add(gitdir);
      if ((await checked(['rev-parse', '--show-object-format'], repo)) !== 'sha1') {
        result.skipped++;
        return;
      }
      const commonGitdir = await repoCommonGitdir(repo);
      const beforeUniqueBytes = options.onStorageReport ? await uniquePackBytes(commonGitdir) : 0;
      const url = await origin(repo);
      const key = url && (await remoteKey(url, repo));
      if (!key) {
        result.skipped++;
        await visitModules(join(gitdir, 'modules'));
        return;
      }
      const root = await storePath();
      await withLock(root, key, async () => {
        const mirror = join(root, 'mirrors', `${key}.git`);
        const mirrorReused = options.onStorageReport ? await isPresent(mirror) : false;
        if (!(await isPresent(mirror))) {
          // Seed from the local repo; fetching afterwards completes refs absent locally.
          await mkdir(dirname(mirror), { recursive: true });
          const staging = join(root, 'tmp', `seed-${process.pid}-${Date.now()}.git`);
          await mkdir(dirname(staging), { recursive: true });
          try {
            await checked(['clone', '--bare', repo, staging]);
            await checked(['-C', staging, 'remote', 'set-url', 'origin', url]);
            await rename(staging, mirror);
          } finally {
            await rm(staging, { recursive: true, force: true });
          }
        }
        await checked([
          '-C',
          mirror,
          'fetch',
          '--prune',
          'origin',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ]);
        await checked(['-C', mirror, '-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d']);
        await writeFile(join(mirror, '.gitx-last-used'), '');
        const source = join(mirror, 'objects', 'pack');
        const target = join(commonGitdir, 'objects', 'pack');
        const mode = await linkMode();
        await mkdir(target, { recursive: true });
        for (const name of await readdir(source).catch(() => [])) {
          if (!/\.(pack|idx|rev)$/.test(name)) continue;
          const from = join(source, name);
          const to = join(target, name);
          const temp = `${to}.gitx-${process.pid}-${Date.now()}`;
          try {
            if (mode === 'copy') await copyFile(from, temp);
            else if (mode === 'reflink')
              await copyFile(from, temp, constants.COPYFILE_FICLONE_FORCE).catch(() => copyFile(from, temp));
            else await link(from, temp).catch(() => copyFile(from, temp));
            await rename(temp, to);
          } finally {
            await rm(temp, { force: true });
          }
        }
        // Copying rather than linking is still safe; link where the filesystem permits.
        await markLinkedPacks(mirror, commonGitdir, mode);
        await checked(['-c', 'repack.writeBitmaps=false', 'repack', '-a', '-d', '--no-pack-kept-objects'], repo);
        const localLfs = join(commonGitdir, 'lfs', 'objects');
        if (await isPresent(localLfs)) await copyTree(localLfs, join(root, 'lfs', 'objects'));
        result.cached++;
        if (options.onStorageReport) {
          const [bytes, afterUniqueBytes] = await Promise.all([
            packReport(mirror, commonGitdir),
            uniquePackBytes(commonGitdir),
          ]);
          emitStorageReport({
            operation: 'cache',
            repository: repo,
            mirrorReused,
            ...bytes,
            beforeUniqueBytes,
            afterUniqueBytes,
            estimatedSavedBytes: Math.max(0, beforeUniqueBytes - afterUniqueBytes),
          });
        }
      });
      async function visitModules(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true }).catch(() => [])) {
          if (!entry.isDirectory()) continue;
          const modulePath = join(directory, entry.name);
          if (await isPresent(join(modulePath, 'HEAD'))) {
            const workTree = (await git(['--git-dir', modulePath, 'config', '--get', 'core.worktree'])).stdout.trim();
            if (workTree) await adopt(resolve(modulePath, workTree));
          } else await visitModules(modulePath);
        }
      }
      await visitModules(join(gitdir, 'modules'));
    }
    await adopt(resolve(cwd, path));
    return result;
  }

  async function storeInfo(): Promise<StoreInfo> {
    const path = await storePath();
    return {
      path,
      sizeBytes: await directorySize(path),
      mirrorCount: (await findMirrors(join(path, 'mirrors'))).length,
    };
  }

  async function fetch(): Promise<{ fetched: number }> {
    const root = await storePath();
    let fetched = 0;
    for (const mirror of await findMirrors(join(root, 'mirrors'))) {
      const key = mirror.slice(join(root, 'mirrors').length + 1, -4);
      await withLock(root, key, async () => {
        await checked([
          '-C',
          mirror,
          'fetch',
          '--prune',
          'origin',
          '+refs/heads/*:refs/heads/*',
          '+refs/tags/*:refs/tags/*',
        ]);
        await checked(['-C', mirror, 'repack', '-d', '--geometric=2']);
        fetched++;
      });
    }
    return { fetched };
  }

  async function gc(unused = '30d'): Promise<{ removed: number }> {
    const match = unused.match(/^(\d+)([dhm])$/);
    if (!match) throw new Error('Expected age such as 30d, 12h, or 60m');
    const age = Number(match[1]) * { d: 86400000, h: 3600000, m: 60000 }[match[2] as 'd' | 'h' | 'm'];
    const root = await storePath();
    let removed = 0;
    for (const mirror of await findMirrors(join(root, 'mirrors'))) {
      const key = mirror.slice(join(root, 'mirrors').length + 1, -4);
      await withLock(root, key, async () => {
        const stamp = await stat(join(mirror, '.gitx-last-used')).catch(() => stat(mirror));
        if (Date.now() - stamp.mtimeMs >= age) {
          await rm(mirror, { recursive: true, force: true });
          removed++;
        }
      });
    }
    return { removed };
  }

  async function doctor(): Promise<DoctorResult> {
    const root = await storePath();
    return withLock(root, 'doctor', async () => {
      const checks: DoctorCheck[] = [];
      const [rootStat, cwdStat] = await Promise.all([stat(root), stat(cwd)]);
      checks.push({
        name: 'filesystem',
        ok: rootStat.dev === cwdStat.dev,
        detail:
          rootStat.dev === cwdStat.dev
            ? 'Store and working directory share a filesystem'
            : 'Store and working directory use different filesystems',
      });
      const testA = join(root, `reflink-${process.pid}-${Date.now()}`);
      const testB = `${testA}-copy`;
      let reflink = false;
      try {
        await writeFile(testA, 'gitx');
        await copyFile(testA, testB, constants.COPYFILE_FICLONE_FORCE);
        reflink = true;
      } catch {
        /* unsupported */
      } finally {
        await rm(testA, { force: true });
        await rm(testB, { force: true });
      }
      checks.push({ name: 'reflink', ok: reflink, detail: reflink ? 'Supported' : 'Unavailable' });
      const binary = await gitPath();
      checks.push({ name: 'git', ok: true, detail: `${binary}: ${await checked(['--version'])}` });
      return { checks };
    });
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
      if (arg.startsWith('-')) return (await git(['worktree', ...args], at, true)).code;
      path = arg;
      break;
    }
    const code = (await git(['worktree', ...args], at, true)).code;
    if (code !== 0 || !path || noCheckout) return code;
    const target = resolve(at, path);
    // Git already shares the superproject object directory between worktrees.
    // Its submodules have separate gitdirs, so populate those through our mirrors.
    if (await isPresent(join(target, '.gitmodules')))
      return updateSubmodules(['update', '--init', '--recursive'], target);
    return 0;
  }

  async function run(args: string[]): Promise<number> {
    const parsed = parseGlobal(args, cwd);
    if (env.GITX_DISABLE === '1' || incomingEnv.GITX_ACTIVE === '1' || hasRepositoryEnvironment || !parsed)
      return (await git(args, cwd, true)).code;
    // Plain forwarding skips the config lookup so gitx stays cheap as an editor's git.path.
    if (!['clone', 'submodule', 'worktree'].includes(parsed.command)) return (await git(args, cwd, true)).code;
    const enabled = await git(['config', '--type=bool', '--get', 'gitx.enabled'], parsed.cwd);
    if (enabled.stdout.trim() === 'false') return (await git(args, cwd, true)).code;
    // -C is resolved explicitly. Other global options can change Git semantics, so forward intact.
    for (let i = 0; i < parsed.prefix.length; i++) {
      const arg = parsed.prefix[i]!;
      if (arg === '-C') {
        i++;
        continue;
      }
      if (arg.startsWith('-C')) continue;
      return (await git(args, cwd, true)).code;
    }
    if (parsed.cwd !== cwd) {
      return createGitx({ ...options, cwd: parsed.cwd, env: incomingEnv }).run([parsed.command, ...parsed.rest]);
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

  return { run, cache, storeInfo, fetch, gc, doctor, storePath, gitVersion };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function copyTree(from: string, to: string): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const entry of await readdir(from, { withFileTypes: true })) {
    const source = join(from, entry.name);
    const destination = join(to, entry.name);
    if (entry.isDirectory()) await copyTree(source, destination);
    else if (entry.isFile() && !(await isPresent(destination))) await copyFile(source, destination);
  }
}

export { keyForRemote };
