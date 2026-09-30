import type { ArgumentsCamelCase, Argv } from 'yargs';
import { dedup } from '../../context.js';
import { humanizeBytes } from 'humanize-units';

export const command = 'remove <path>';
export const describe = 'Detach a checkout and its submodules from the shared store';
export const builder = (parser: Argv) =>
  parser
    .positional('path', {
      type: 'string',
      demandOption: true,
      describe: 'Local checkout path',
    })
    .option('verbose', {
      type: 'boolean',
      default: false,
      describe: 'Show full Git errors for skipped and failed repositories',
    })
    .option('forget', {
      type: 'boolean',
      default: false,
      describe: 'Release a deleted checkout so store prune can reclaim its objects',
    });

export const handler = async (args: ArgumentsCamelCase<{ path: string; verbose: boolean; forget: boolean }>) => {
  if (args.forget) {
    const forgotten = await dedup().forget(args.path);
    for (const gitdir of forgotten) console.log(`Forgot ${gitdir}`);
    if (!forgotten.length) {
      console.error(`No registered checkout matches ${args.path}.`);
      process.exitCode = 1;
    }
    return;
  }
  const result = await dedup().remove(args.path);
  for (const repository of result.repositories) {
    if (repository.status === 'removed')
      console.log(`Removed ${repository.path}: objects now use ${humanizeBytes(repository.objectBytes ?? 0)}`);
    else
      console.error(
        `${repository.status === 'failed' ? 'Failed' : 'Skipped'} ${repository.path}: ${repository.reason}`,
      );
    if (args.verbose && repository.detail) console.error(repository.detail);
  }
  if (!result.removed && !result.failed) console.log(`Nothing to remove: ${args.path} is not linked to the store.`);
  else console.log(`Removed ${result.removed} repository(s); skipped ${result.skipped}; failed ${result.failed}.`);
  if (result.failed) process.exitCode = 1;
};
