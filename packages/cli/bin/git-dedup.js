#!/usr/bin/env node
// Runs the native git-dedup binary for this platform. The package ships one per supported OS and CPU.
import { spawn } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const target = `${process.platform}-${process.arch}`;
const name = process.platform === 'win32' ? 'git-dedup.exe' : 'git-dedup';
const packaged = fileURLToPath(new URL(`../native/${target}/${name}`, import.meta.url));
if (!existsSync(packaged)) {
  console.error(
    `git-dedup: no native binary for ${target}. Supported: linux, darwin, and win32 on x64 and arm64. ` +
      'See https://git-dedup.ben3d.ca for other installation methods.',
  );
  process.exit(1);
}

/**
 * npm packages do not reliably keep executable bits, so make the binary runnable: mark it executable, or, when
 * this user cannot (for example, a root-owned global install), run a private copy cached per version.
 */
function runnable(binary) {
  if (process.platform === 'win32') return binary;
  try {
    accessSync(binary, constants.X_OK);
    return binary;
  } catch {}
  try {
    chmodSync(binary, 0o755);
    return binary;
  } catch {}
  const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const cache = join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'git-dedup', version, target);
  const copy = join(cache, name);
  try {
    accessSync(copy, constants.X_OK);
    return copy;
  } catch {}
  mkdirSync(cache, { recursive: true });
  // Concurrent first runs each write their own file; the rename makes the finished copy appear at once.
  const partial = `${copy}.${process.pid}`;
  copyFileSync(binary, partial);
  chmodSync(partial, 0o755);
  renameSync(partial, copy);
  return copy;
}

const binary = runnable(packaged);
// A `git` shim that points at this launcher must not make git-dedup run itself as Git.
const launcher = realpathSync(fileURLToPath(import.meta.url));
const child = spawn(binary, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, GIT_DEDUP_LAUNCHER: launcher },
});
// The terminal delivers interrupts to the whole process group, so the binary (and Git) handle them; stay alive
// to report the binary's exit status. Forward signals sent to this process alone, such as from a process manager.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    if (signal !== 'SIGINT') child.kill(signal);
  });
}
child.on('error', (error) => {
  console.error(`git-dedup: cannot start ${binary}: ${error.message}`);
  process.exit(1);
});
child.on('exit', (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else process.exit(code ?? 1);
});
