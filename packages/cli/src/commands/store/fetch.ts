import { dedup } from '../../context.js';

export const command = 'fetch';
export const describe = 'Fetch registered remotes into the shared object pool';
export const handler = async () => {
  const result = await dedup().fetch();
  for (const remote of result.remotes)
    if (remote.status === 'failed') console.error(`Failed ${remote.key}: ${remote.reason}`);
  console.log(`Fetched ${result.fetched} remote(s); ${result.failed} failed.`);
  if (result.failed) process.exitCode = 1;
};
