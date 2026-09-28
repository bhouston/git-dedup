import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { infoFromPackageJson } from '@clidoc/core';
import { fromYargs } from '@clidoc/yargs';
import type { OpenCliDocument } from '@clidoc/core';
import type { Argv, CommandModule } from 'yargs';
import { fileCommands } from 'yargs-file-commands';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadCommands(): Promise<CommandModule[]> {
  return fileCommands({ commandDirs: [join(here, 'commands')] });
}

/** Adapt fileCommands' nested arrays to clidoc's individual command recorder. */
function forDocument(module: CommandModule): CommandModule {
  if (typeof module.builder !== 'function') return module;
  const children: CommandModule[] = [];
  const recorder = new Proxy({} as Argv, {
    get:
      (_target, method) =>
      (...args: unknown[]) => {
        if (method === 'command') {
          const value = args[0];
          if (Array.isArray(value)) children.push(...(value as CommandModule[]));
          else if (value && typeof value === 'object') children.push(value as CommandModule);
        }
        return recorder;
      },
  });
  module.builder(recorder);
  if (children.length === 0) return module;
  const defaultChild = children.find((child) => child.command === '$0');
  return {
    ...module,
    describe: defaultChild?.describe ?? module.describe,
    builder: (parser: Argv) => {
      for (const child of children) {
        if (child !== defaultChild) parser.command(forDocument(child));
      }
      return parser;
    },
  };
}

export function documentFromCommands(commands: CommandModule[]): OpenCliDocument {
  const packageInfo = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as Record<string, unknown>;
  const document = fromYargs(
    commands.map(forDocument),
    infoFromPackageJson(packageInfo, { title: 'gitx', binary: 'gitx' }),
  );
  document.global = {
    flags: [
      {
        name: 'stats',
        type: 'boolean',
        summary: 'Show estimated shared storage savings for clone or cache',
      },
    ],
  };
  document.commands ??= {};
  document.commands['gitx clone'] = {
    summary: 'Clone a repository through the shared store when supported',
    args: [
      { name: 'repository', required: true },
      { name: 'directory', required: false },
    ],
  };
  return document;
}

export async function cliDocument(): Promise<OpenCliDocument> {
  return documentFromCommands(await loadCommands());
}
