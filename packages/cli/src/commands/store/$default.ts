import { gitx } from '../../context.js';

export const describe = 'Show the shared store';
export const handler = async () => {
  const info = await gitx().storeInfo();
  console.log(`${info.path}\nMirrors: ${info.mirrorCount}\nSize: ${info.sizeBytes} bytes`);
};
