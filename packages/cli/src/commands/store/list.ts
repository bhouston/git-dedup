import { dedup } from '../../context.js';

export const command = 'list';
export const describe = 'List remotes registered in the shared store';
export const handler = async () => {
  const remotes = await dedup().listRemotes();
  if (!remotes.length) {
    console.log('No remotes registered.');
    return;
  }
  console.log('KEY\tFETCH URL');
  for (const { key, remote } of remotes) console.log(`${key}\t${remote}`);
};
