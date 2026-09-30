import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { infoFromPackageJson } from '@clidoc/core';
import { fromYargsAsync } from '@clidoc/yargs';
import type { OpenCliDocument } from '@clidoc/core';
import type { CommandModule } from 'yargs';
import { fileCommands } from 'yargs-file-commands';

const here = dirname(fileURLToPath(import.meta.url));

export async function loadCommands(): Promise<CommandModule[]> {
  return fileCommands({ commandDirs: [join(here, 'commands')] });
}

export async function documentFromCommands(commands: CommandModule[]): Promise<OpenCliDocument> {
  const packageInfo = JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')) as Record<string, unknown>;
  const document = await fromYargsAsync(commands, infoFromPackageJson(packageInfo, { title: 'gitx', binary: 'gitx' }));
  document.global = {
    flags: [
      {
        name: 'stats',
        type: 'boolean',
        summary: 'Show object pool use and cache storage measurements',
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
