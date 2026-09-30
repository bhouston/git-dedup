import { execFile, spawn } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);

async function isInsideWorktree(path: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', path, 'rev-parse', '--is-inside-work-tree']);
    return stdout.trim() === 'true';
  } catch {
    return false;
  }
}

async function ignoredDirectories(path: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set();
  const output = await new Promise<string>((done, reject) => {
    const child = spawn('git', ['-C', path, 'check-ignore', '--no-index', '-z', '--stdin']);
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      if (code === 0 || code === 1) done(Buffer.concat(stdout).toString());
      else reject(new Error(`git check-ignore failed: ${Buffer.concat(stderr).toString().trim()}`));
    });
    child.stdin.end(names.join('\0') + '\0');
  });
  return new Set(output.split('\0').filter(Boolean));
}

export interface DiscoveredCheckout {
  path: string;
  gitDir: string;
  commonGitDir: string;
  /** The parent repository whose store add operation visits this initialized submodule. */
  coveredBy?: string;
}

/** Discover checkout roots without following symlinks or entering ignored directories or Git metadata. */
export async function discoverCheckouts(directory: string): Promise<DiscoveredCheckout[]> {
  const root = resolve(directory);
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const candidates: string[] = [];
  const pending = [{ path: root, insideWorktree: await isInsideWorktree(root) }];
  while (pending.length) {
    const { path: current, insideWorktree } = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    const hasGit = entries.some((entry) => entry.name === '.git' && (entry.isFile() || entry.isDirectory()));
    if (hasGit) candidates.push(current);
    const directories = entries.filter((entry) => entry.isDirectory() && entry.name !== '.git');
    const excluded =
      insideWorktree || hasGit
        ? await ignoredDirectories(
            current,
            directories.map((entry) => entry.name),
          )
        : new Set<string>();
    for (const entry of directories) {
      if (!excluded.has(entry.name))
        pending.push({ path: join(current, entry.name), insideWorktree: insideWorktree || hasGit });
    }
  }

  const unique = new Map<string, DiscoveredCheckout>();
  for (const path of candidates.toSorted((a, b) => a.length - b.length || a.localeCompare(b))) {
    try {
      const { stdout } = await execFileAsync('git', [
        '-C',
        path,
        'rev-parse',
        '--absolute-git-dir',
        '--path-format=absolute',
        '--git-common-dir',
      ]);
      const [rawGitDir, rawCommonDir] = stdout.trim().split('\n');
      if (!rawGitDir || !rawCommonDir) continue;
      const gitDir = await realpath(isAbsolute(rawGitDir) ? rawGitDir : resolve(path, rawGitDir));
      const commonGitDir = await realpath(isAbsolute(rawCommonDir) ? rawCommonDir : resolve(path, rawCommonDir));
      if (!unique.has(commonGitDir)) unique.set(commonGitDir, { path, gitDir, commonGitDir });
    } catch {
      // A .git entry alone is not enough to identify a valid checkout.
    }
  }
  const found = [...unique.values()].toSorted((a, b) => a.path.localeCompare(b.path));
  for (const child of found) {
    const parent = found
      .filter((candidate) => candidate !== child && child.path.startsWith(candidate.path + sep))
      .find((candidate) => child.gitDir.startsWith(join(candidate.gitDir, 'modules') + sep));
    if (parent) child.coveredBy = parent.path;
  }
  return found;
}
