import { gitx } from '../../context.js';

export const command = 'refresh';
export const describe = 'Fetch and repack all mirrors';
export const handler = async () => {
  const result = await gitx().refresh();
  console.log(`Refreshed ${result.refreshed} mirror(s).`);
};
