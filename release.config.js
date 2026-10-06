import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildNative } from './scripts/build-native.mjs';

// The npm package: a launcher plus the native binary for every supported platform.
export const releasePackages = ['packages/cli'];

export default {
  branches: ['main'],
  repositoryUrl: 'https://github.com/bhouston/git-dedup.git',
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ...releasePackages.map((path) => ['@anolilab/semantic-release-pnpm', { pkgRoot: path }]),
    {
      // Runs before any publish step, so npm receives binaries that report the released version.
      prepare: (_config, { nextRelease }) => {
        buildNative({ all: true, version: nextRelease.version });
        const tarballDir = resolve('release-artifacts');
        mkdirSync(tarballDir, { recursive: true });
        for (const path of releasePackages) {
          execFileSync('pnpm', ['--dir', path, 'pack', '--pack-destination', tarballDir], {
            stdio: 'inherit',
          });
        }
      },
    },
    [
      '@semantic-release/github',
      {
        assets: ['release-artifacts/*.tgz'],
        successComment: false,
        failComment: false,
        releasedLabels: false,
      },
    ],
  ],
};
