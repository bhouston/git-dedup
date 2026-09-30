import { execFile } from 'node:child_process';
import { readdir, realpath, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { isAbsolute, join, resolve, sep } from 'node:path';

const execFileAsync = promisify(execFile);
const ignored = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.nuxt',
  '.turbo',
  '.venv',
  'build',
  'coverage',
  'dist',
  'node_modules',
  'target',
  'vendor',
]);

export interface DiscoveredCheckout {
  path: string;
  gitDir: string;
  commonGitDir: string;
  /** The parent repository whose store add operation visits this initialized submodule. */
  coveredBy?: string;
}

/** Discover checkout roots without following symlinks or entering Git/object/build directories. */
export async function discoverCheckouts(directory: string): Promise<DiscoveredCheckout[]> {
  const root = resolve(directory);
  if (!(await stat(root)).isDirectory()) throw new Error(`Not a directory: ${root}`);
  const candidates: string[] = [];
  const pending = [root];
  while (pending.length) {
    const current = pending.pop()!;
    const entries = await readdir(current, { withFileTypes: true });
    if (entries.some((entry) => entry.name === '.git' && (entry.isFile() || entry.isDirectory())))
      candidates.push(current);
    for (const entry of entries) {
      if (entry.isDirectory() && !ignored.has(entry.name)) pending.push(join(current, entry.name));
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
