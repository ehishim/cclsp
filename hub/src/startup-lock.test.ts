// Startup-lock tests prove one cold daemon owner and stale-lock recovery.

import { afterEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireDaemonLock } from './startup-lock.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cclsp-start-lock-'));
  fixtures.push(root);
  return join(root, 'daemon.pid');
}

describe('cclsp Hub daemon startup lock', () => {
  it('admits one live owner and releases only its own lock', () => {
    const path = fixture();
    const release = acquireDaemonLock(path, 101, { isAlive: () => true });
    expect(release).toBeTypeOf('function');
    expect(acquireDaemonLock(path, 202, { isAlive: (pid) => pid === 101 })).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe('101');
    release?.();
    expect(existsSync(path)).toBe(false);
  });

  it('replaces a stale holder and does not remove a successor lock', () => {
    const path = fixture();
    writeFileSync(path, '303');
    const release = acquireDaemonLock(path, 404, { isAlive: () => false });
    expect(readFileSync(path, 'utf8')).toBe('404');
    writeFileSync(path, '505');
    release?.();
    expect(readFileSync(path, 'utf8')).toBe('505');
  });
});
