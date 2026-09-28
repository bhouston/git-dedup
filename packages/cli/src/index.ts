import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGitx } from '@bhouston/gitx-core';
import type { StorageReport } from '@bhouston/gitx-core';
import { handleOpenCliRequest } from '@clidoc/core';
import yargs from 'yargs';
import { documentFromCommands, loadCommands } from './document.js';
import { printStorageReports } from './stats.js';

const here = dirname(fileURLToPath(import.meta.url));
const packageInfo = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as {
  version: string;
  description: string;
};
const ownCommands = new Set(['cache', 'store', 'doctor', 'docgen', '__opencli']);

/** Run the gitx CLI. All Git commands retain their original argument array. */
export async function main(args = process.argv.slice(2)): Promise<number> {
  const stats = args[0] === '--stats';
  const forwardedArgs = stats ? args.slice(1) : args;
  const first = forwardedArgs[0];
  const runGit = async (): Promise<number> => {
    if (!stats) return createGitx().run(args);
    const reports: StorageReport[] = [];
    const code = await createGitx({ onStorageReport: (report) => reports.push(report) }).run(forwardedArgs);
    printStorageReports(reports);
    return code;
  };
  if (
    first &&
    !ownCommands.has(first) &&
    first !== '--help' &&
    first !== '-h' &&
    first !== '--version' &&
    first !== '-v' &&
    first !== '--opencli'
  ) {
    return runGit();
  }

  const parser = yargs(args)
    .scriptName('gitx')
    .usage(
      '$0 <command> [options]\n\nGit commands pass through to Git; clone, submodule, and worktree can use the shared store.',
    )
    .version(packageInfo.version)
    .help()
    .option('stats', { type: 'boolean', describe: 'Show estimated shared storage savings for clone or cache' })
    .strict()
    .showHelpOnFail(true);
  const commands = await loadCommands();
  parser.command(commands);
  const document = documentFromCommands(commands);

  if (first === '--opencli') {
    await handleOpenCliRequest(['__opencli', ...forwardedArgs.slice(1)], () => document);
    return 0;
  }
  if (await handleOpenCliRequest(forwardedArgs, () => document)) return 0;
  if (args.length === 0) {
    parser.showHelp();
    return 0;
  }
  await parser.parseAsync();
  return Number(process.exitCode ?? 0);
}
