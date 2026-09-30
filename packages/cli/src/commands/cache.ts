import type { ArgumentsCamelCase, Argv } from 'yargs';
import type { CacheResult, StorageReport } from 'git-dedup-core';
import { dedup } from '../context.js';
import { printStorageReports } from '../stats.js';
import { discoverCheckouts } from '../discover.js';

export const command = 'cache [path]';
export const describe = 'Adopt or relink a repository to the shared store';
export const builder = (parser: Argv) =>
  parser
    .positional('path', {
      type: 'string',
      describe: 'Repository path (defaults to the current directory)',
    })
    .option('stats', {
      type: 'boolean',
      default: false,
      describe: 'Show the change in private pack storage',
    })
    .option('all', {
      type: 'boolean',
      default: false,
      describe: 'Discover and cache all checkouts under the directory',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Preview checkouts discovered by --all without caching',
    })
    .option('verbose', {
      type: 'boolean',
      default: false,
      describe: 'Show full Git errors for skipped and failed repositories',
    });

function reportRepositories(result: CacheResult, verbose: boolean): void {
  for (const repository of result.repositories) {
    if (!repository.reason) continue;
    const label = repository.status === 'cached' ? 'Warning' : repository.status === 'failed' ? 'Failed' : 'Skipped';
    console.error(`${label} ${repository.path}: ${repository.reason}`);
    if (verbose && repository.detail) console.error(repository.detail);
  }
}

export const handler = async (
  args: ArgumentsCamelCase<{ path?: string; stats: boolean; all: boolean; dryRun: boolean; verbose: boolean }>,
) => {
  if (args.dryRun && !args.all) throw new Error('--dry-run requires --all');
  const reports: StorageReport[] = [];
  const client = dedup(args.stats ? { onStorageReport: (report) => reports.push(report) } : undefined);
  if (args.all) {
    const targets = await discoverCheckouts(args.path ?? process.cwd());
    console.log(`Discovered ${targets.length} checkout(s):`);
    for (const target of targets)
      console.log(`  ${target.path}${target.coveredBy ? ` (submodule of ${target.coveredBy})` : ''}`);
    if (args.dryRun) return;
    const completed = new Set<string>();
    let cached = 0;
    let skipped = 0;
    let failed = 0;
    for (const target of targets) {
      if (target.coveredBy && completed.has(target.coveredBy)) {
        console.log(`Skipped ${target.path}: handled with ${target.coveredBy}`);
        continue;
      }
      try {
        const result = await client.cache(target.path);
        cached += result.cached;
        skipped += result.skipped;
        failed += result.failed;
        reportRepositories(result, args.verbose);
        completed.add(target.path);
        console.log(
          `Finished ${target.path}: cached ${result.cached}, skipped ${result.skipped}, failed ${result.failed}`,
        );
      } catch (error) {
        failed++;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`Failed ${target.path}: cache operation failed`);
        if (args.verbose) console.error(detail);
      }
    }
    console.log(`Cached ${cached} repository(s); skipped ${skipped}; failed ${failed}.`);
    if (args.stats) printStorageReports(reports);
    if (failed) process.exitCode = 1;
    return;
  }
  const result = await client.cache(args.path);
  reportRepositories(result, args.verbose);
  console.log(`Cached ${result.cached} repository(s); skipped ${result.skipped}; failed ${result.failed}.`);
  if (args.stats) printStorageReports(reports);
  if (result.failed) process.exitCode = 1;
};
