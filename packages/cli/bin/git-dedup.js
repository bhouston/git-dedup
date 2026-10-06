#!/usr/bin/env node
// Runs the native git-dedup binary for this platform. The package ships one per supported OS and CPU.
import { spawn } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const target = `${process.platform}-${process.arch}`;
const name = process.platform === 'win32' ? 'git-dedup.exe' : 'git-dedup';
const binary = fileURLToPath(new URL(`../native/${target}/${name}`, import.meta.url));
if (!existsSync(binary)) {
  console.error(
    `git-dedup: no native binary for ${target}. Supported: linux, darwin, and win32 on x64 and arm64. ` +
      'See https://git-dedup.ben3d.ca for other installation methods.',
  );
  process.exit(1);
}

if (process.platform !== 'win32') {
  try {
    accessSync(binary, constants.X_OK);
  } catch {
    // An archive that lost its mode bits; repair it when this user may.
    try {
      chmodSync(binary, 0o755);
    } catch {}
  }
}

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
