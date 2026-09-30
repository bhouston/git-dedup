import { humanizeBytes } from 'humanize-units';

import { dedup } from '../../context.js';

export const describe = 'Show the shared store and its health';
export const handler = async () => {
  const client = dedup();
  const info = await client.storeInfo();
  console.log(`${info.path}\nRemotes: ${info.remoteCount}\nSize: ${humanizeBytes(info.sizeBytes)}`);
  const health = await client.doctor();
  if (health.empty) {
    console.log('The store is empty. Start with `git-dedup clone <url>` or `git-dedup store add [path]`.');
  }
  for (const check of health.checks) {
    console.log(`${check.ok ? 'OK' : 'WARN'} ${check.name}: ${check.detail}`);
  }
  if (health.checks.some((check) => !check.ok)) process.exitCode = 1;
};
