import type { StorageReport } from '@bhouston/gitx-core';

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  const units = ['KiB', 'MiB', 'GiB', 'TiB'];
  let scaled = value;
  let unit = -1;
  do {
    scaled /= 1024;
    unit++;
  } while (scaled >= 1024 && unit < units.length - 1);
  return `${scaled.toFixed(1)} ${units[unit]}`;
}

/** Report logical pack bytes; no filesystem allocation estimate is available. */
export function printStorageReports(reports: StorageReport[]): void {
  for (const report of reports) {
    const prefix = `gitx: ${report.operation} ${report.repository}: ${report.poolReused ? 'reused' : 'created'} object pool; `;
    if (report.operation === 'cache') {
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
    if (reports[0]?.operation === 'cache') {
      process.stderr.write(
        `gitx: estimated private pack reduction ${bytes(total)} (${total.toLocaleString('en-US')} bytes); ` +
          'logical pack bytes only; actual disk reclaimed may differ.\n',
      );
    } else {
      process.stderr.write('gitx: clone storage depends on objects already present in the shared pool.\n');
    }
  }
}
