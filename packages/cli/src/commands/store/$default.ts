import { dedup } from '../../context.js';

export const describe = 'Show the shared store';
export const handler = async () => {
  const info = await dedup().storeInfo();
  console.log(`${info.path}\nRemotes: ${info.remoteCount}\nSize: ${info.sizeBytes} bytes`);
};
