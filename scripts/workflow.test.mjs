import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { analyzeCommits } from '@semantic-release/commit-analyzer';
import releaseConfig, { releasePackages } from '../release.config.js';
import { checkPullRequest } from './check-pr.mjs';

for (const [message, expected] of [
  ['fix: handle empty output', 'patch'],
  ['feat: add mirror refresh', 'minor'],
  ['feat!: remove old API', 'major'],
  ['fix: change API\n\nBREAKING CHANGE: remove legacy arguments', 'major'],
  ['chore: update workflow', null],
]) {
  test(`release analysis: ${message.split('\n')[0]}`, async () => {
    const actual = await analyzeCommits(releaseConfig.plugins[0][1], {
      cwd: process.cwd(),
      commits: [{ hash: 'test', message }],
      logger: { log() {} },
    });
    assert.equal(actual, expected);
  });
}

test('release branch and publication order', () => {
  assert.deepEqual(releaseConfig.branches, ['main']);
  assert.deepEqual(releasePackages, ['packages/core', 'packages/cli']);
  const published = releaseConfig.plugins
    .filter((plugin) => Array.isArray(plugin) && plugin[0] === '@anolilab/semantic-release-pnpm')
    .map(([, options]) => options.pkgRoot);
  assert.deepEqual(published, releasePackages);
  assert.ok(!published.includes('packages/website'));
});

test('release is manual and runs CI before publishing', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n  push:/);
  assert.match(workflow, /needs: \[guard, checks\]/);
  assert.match(workflow, /uses: \.\/\.github\/workflows\/ci\.yml/);
  assert.match(workflow, /id-token: write/);
  assert.match(workflow, /pnpm release/);
});

test('PR policy requires main and a linked issue', () => {
  assert.doesNotThrow(() => checkPullRequest({ base: { ref: 'main' }, body: 'Closes #42' }));
  assert.throws(() => checkPullRequest({ base: { ref: 'other' }, body: 'Closes #42' }));
  assert.throws(() => checkPullRequest({ base: { ref: 'main' }, body: 'No issue' }));
});
