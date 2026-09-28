import { writeOpenCliDocument } from '@clidoc/core';
import type { DocumentFormat } from '@clidoc/core';
import type { ArgumentsCamelCase, Argv } from 'yargs';
import { cliDocument } from '../document.js';

export const command = 'docgen';
export const describe = 'Write the OpenCLI document to a file, or stdout if --output is omitted';
export const builder = (parser: Argv) =>
  parser
    .option('output', { type: 'string', alias: 'o', describe: 'Output file; defaults to stdout' })
    .option('format', {
      type: 'string',
      choices: ['json', 'yaml', 'markdown'] as const,
      default: 'json',
      describe: 'Output format',
    });
export const handler = async (args: ArgumentsCamelCase<{ output?: string; format: DocumentFormat }>) => {
  await writeOpenCliDocument(await cliDocument(), args.output, args.format);
};
