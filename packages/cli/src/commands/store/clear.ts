import { gitx } from '../../context.js';

export const command = 'clear';
export const describe = 'Delete the shared store';
export const handler = async () => {
  await gitx().clear();
  console.log('Store cleared.');
};
