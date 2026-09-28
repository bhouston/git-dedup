import { gitx } from '../../context.js';

export const command = 'fetch';
export const describe = 'Fetch and repack all mirrors';
export const handler = async () => {
  const result = await gitx().fetch();
  console.log(`Fetched ${result.fetched} mirror(s).`);
};
