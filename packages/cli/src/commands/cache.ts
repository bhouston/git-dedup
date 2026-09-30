import type { ArgumentsCamelCase, Argv } from 'yargs';
import type { StorageReport } from '@bhouston/gitx-core';
import { gitx } from '../context.js';
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
    });
export const handler = async (
  args: ArgumentsCamelCase<{ path?: string; stats: boolean; all: boolean; dryRun: boolean }>,
) => {
  if (args.dryRun && !args.all) throw new Error('--dry-run requires --all');
  const reports: StorageReport[] = [];
  const client = gitx(args.stats ? { onStorageReport: (report) => reports.push(report) } : undefined);
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
        completed.add(target.path);
        console.log(`Finished ${target.path}: cached ${result.cached}, skipped ${result.skipped}`);
      } catch (error) {
        failed++;
        console.error(`Failed ${target.path}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`Cached ${cached} repository(s); skipped ${skipped}; failed ${failed}.`);
    if (args.stats) printStorageReports(reports);
    if (failed) process.exitCode = 1;
    return;
  }
  const result = await client.cache(args.path);
  console.log(`Cached ${result.cached} repository(s); skipped ${result.skipped}.`);
  if (args.stats) printStorageReports(reports);
};
