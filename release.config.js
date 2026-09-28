import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

// Publish dependencies first. pnpm resolves workspace:* to a concrete range.
export const releasePackages = ['packages/core', 'packages/cli'];

export default {
  branches: ['main'],
  repositoryUrl: 'https://github.com/bhouston/gix.git',
  tagFormat: 'v${version}',
  plugins: [
    ['@semantic-release/commit-analyzer', { preset: 'conventionalcommits' }],
    ['@semantic-release/release-notes-generator', { preset: 'conventionalcommits' }],
    ...releasePackages.map((path) => ['@anolilab/semantic-release-pnpm', { pkgRoot: path }]),
    {
      prepare: () => {
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
