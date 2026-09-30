import type { ArgumentsCamelCase, Argv } from 'yargs';
import type { StorageReport } from '@bhouston/gitx-core';
import { gitx } from '../context.js';
import { printStorageReports } from '../stats.js';

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
    });
export const handler = async (args: ArgumentsCamelCase<{ path?: string; stats: boolean }>) => {
  const reports: StorageReport[] = [];
  const result = await gitx(args.stats ? { onStorageReport: (report) => reports.push(report) } : undefined).cache(
    args.path,
  );
  console.log(`Cached ${result.cached} repository(s); skipped ${result.skipped}.`);
  if (args.stats) printStorageReports(reports);
};
