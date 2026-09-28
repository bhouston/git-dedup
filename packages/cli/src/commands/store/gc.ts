import type { ArgumentsCamelCase, Argv } from 'yargs';
import { gitx } from '../../context.js';

export const command = 'gc';
export const describe = 'Remove mirrors unused for a given period';
export const builder = (parser: Argv) =>
  parser.option('unused', {
    type: 'string',
    default: '30d',
    describe: 'Minimum age since last use, e.g. 30d',
  });
export const handler = async (args: ArgumentsCamelCase<{ unused: string }>) => {
  const result = await gitx().gc(args.unused);
  console.log(`Removed ${result.removed} mirror(s).`);
};
