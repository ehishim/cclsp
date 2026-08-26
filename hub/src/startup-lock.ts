// Daemon startup lock prevents concurrent cold clients from creating orphan Hub processes.

import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function acquireDaemonLock(
  path: string,
  pid = process.pid,
  options: { isAlive?: (pid: number) => boolean } = {},
): (() => void) | null {
  const isAlive = options.isAlive ?? processAlive;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(pid), { flag: 'wx' });
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try {
          if (readFileSync(path, 'utf8').trim() === String(pid)) unlinkSync(path);
        } catch {
          // The lock was already removed or replaced by a later daemon.
        }
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder = Number.NaN;
      try { holder = Number.parseInt(readFileSync(path, 'utf8').trim(), 10); } catch {}
      if (Number.isInteger(holder) && holder > 0 && isAlive(holder)) return null;
      try { unlinkSync(path); } catch {}
    }
  }
  throw new Error(`could not acquire cclsp-hub daemon lock: ${path}`);
}
