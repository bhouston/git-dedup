import type { ArgumentsCamelCase, Argv } from 'yargs';
import type { StoreAddResult, StorageReport } from 'git-dedup-core';
import { dedup } from '../../context.js';
import { printStorageReports } from '../../stats.js';
import { discoverCheckouts } from '../../discover.js';

export const command = 'add [path]';
export const describe = 'Add a local checkout to the shared store; linked checkouts depend on it';
export const builder = (parser: Argv) =>
  parser
    .positional('path', {
      type: 'string',
      describe: 'Local checkout path (defaults to the current directory)',
    })
    .option('stats', {
      type: 'boolean',
      default: false,
      describe: 'Show the change in private pack storage',
    })
    .option('all', {
      type: 'boolean',
      default: false,
      describe: 'Discover and add all checkouts under the directory',
    })
    .option('dry-run', {
      type: 'boolean',
      default: false,
      describe: 'Preview checkouts discovered by --all without adding them',
    })
    .option('verbose', {
      type: 'boolean',
      default: false,
      describe: 'Show full Git errors for skipped and failed repositories',
    });

function reportRepositories(result: StoreAddResult, verbose: boolean): void {
  for (const repository of result.repositories) {
    if (!repository.reason) continue;
    const label = repository.status === 'added' ? 'Warning' : repository.status === 'failed' ? 'Failed' : 'Skipped';
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
    let added = 0;
    let skipped = 0;
    let failed = 0;
    for (const target of targets) {
      if (target.coveredBy && completed.has(target.coveredBy)) {
        console.log(`Skipped ${target.path}: handled with ${target.coveredBy}`);
        continue;
      }
      try {
        const result = await client.add(target.path);
        added += result.added;
        skipped += result.skipped;
        failed += result.failed;
        reportRepositories(result, args.verbose);
        completed.add(target.path);
        console.log(
          `Finished ${target.path}: added ${result.added}, skipped ${result.skipped}, failed ${result.failed}`,
        );
      } catch (error) {
        failed++;
        const detail = error instanceof Error ? error.message : String(error);
        console.error(`Failed ${target.path}: store add operation failed`);
        if (args.verbose) console.error(detail);
      }
    }
    console.log(`Added ${added} repository(s); skipped ${skipped}; failed ${failed}.`);
    if (args.stats) printStorageReports(reports);
    if (failed) process.exitCode = 1;
    return;
  }
  const result = await client.add(args.path);
  reportRepositories(result, args.verbose);
  console.log(`Added ${result.added} repository(s); skipped ${result.skipped}; failed ${result.failed}.`);
  if (args.stats) printStorageReports(reports);
  if (result.failed) process.exitCode = 1;
};
