import { dedup } from '../../context.js';

export const describe = 'Show the shared store and its health';
export const handler = async () => {
  const client = dedup();
  const info = await client.storeInfo();
  console.log(`${info.path}\nRemotes: ${info.remoteCount}\nSize: ${info.sizeBytes} bytes`);
  const health = await client.doctor();
  for (const check of health.checks) {
    console.log(`${check.ok ? 'OK' : 'WARN'} ${check.name}: ${check.detail}`);
  }
  if (health.checks.some((check) => !check.ok)) process.exitCode = 1;
};
