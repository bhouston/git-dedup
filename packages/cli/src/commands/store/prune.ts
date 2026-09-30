import { humanizeBytes } from 'humanize-units';
import { dedup } from '../../context.js';

export const command = 'prune';
export const describe = 'Reclaim pool objects that no registered checkout uses';
export const handler = async () => {
  const result = await dedup().prune();
  console.log(`Reclaimed ${humanizeBytes(result.reclaimedBytes)}.`);
};
