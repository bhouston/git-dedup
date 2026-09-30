import { createGitDedup } from 'git-dedup-core';
import type { GitDedupOptions } from 'git-dedup-core';

export const dedup = (options?: GitDedupOptions) => createGitDedup(options);
