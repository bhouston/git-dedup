import { gitx } from '../../context.js';

export const command = 'fetch';
export const describe = 'Fetch registered remotes into the shared object pool';
export const handler = async () => {
  const result = await gitx().fetch();
  console.log(`Fetched ${result.fetched} remote(s).`);
};
