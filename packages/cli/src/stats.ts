import type { StorageReport } from 'git-dedup-core';

import { humanizeBytes as bytes } from 'humanize-units';

/** Report logical pack bytes; no filesystem allocation estimate is available. */
export function printStorageReports(reports: StorageReport[]): void {
  for (const report of reports) {
    const prefix = `git-dedup: ${report.operation} ${report.repository}: ${report.poolReused ? 'reused' : 'created'} object pool; `;
    if (report.operation === 'add') {
      process.stderr.write(
        prefix +
          `private packs ${bytes(report.beforeUniqueBytes ?? 0)} -> ${bytes(report.afterUniqueBytes ?? 0)}; ` +
          `estimated private pack reduction ${bytes(report.estimatedSavedBytes)}\n`,
      );
    } else {
      process.stderr.write(prefix + 'objects borrowed through Git alternates\n');
    }
  }
  if (reports.length) {
    const total = reports.reduce((sum, report) => sum + report.estimatedSavedBytes, 0);
    if (reports[0]?.operation === 'add') {
      process.stderr.write(
        `git-dedup: estimated private pack reduction ${bytes(total)}; ` +
          'logical pack bytes only; actual disk reclaimed may differ.\n',
      );
    } else {
      process.stderr.write(
        `git-dedup: ${reports[0]?.operation} storage depends on objects already present in the shared pool.\n`,
      );
    }
  }
}
