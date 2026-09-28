import type { ArgumentsCamelCase, Argv } from 'yargs';
import { gitx } from '../../context.js';

export const command = 'set <path>';
export const describe = 'Set the global store location';
export const builder = (parser: Argv) =>
  parser.positional('path', {
    type: 'string',
    demandOption: true,
    describe: 'Store directory',
  });
export const handler = async (args: ArgumentsCamelCase<{ path: string }>) => {
  console.log(await gitx().setStore(args.path));
};
