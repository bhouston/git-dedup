import { gitx } from '../../context.js';

export const command = 'gc';
export const describe = 'Compact the shared object pool without pruning consumer objects';
export const handler = async () => {
  const result = await gitx().gc();
  console.log(result.compacted ? 'Compacted the shared object pool.' : 'The shared object pool is empty.');
};
