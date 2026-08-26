// Where a complete answer is written when a projection or a transport frame is
// bounded. Bounding never discards provider data: the caller receives the exact
// path instead, so the full result stays readable and greppable.
//
// The directory is process-owner private (0700) and each file carries a random
// component, because a consumer that runs as another actor must never be able to
// enumerate or read an answer produced for someone else. A consumer that hands
// this path to a different principal is responsible for copying it into that
// principal's own lane rather than forwarding this one.

import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function resultSpoolDir(): string {
  return process.env.CCLSP_RESULT_DIR || join(tmpdir(), 'cclsp-results');
}

/** Creates the private spool directory and returns one unused path inside it. */
export function spoolFilePath(operation: string, stamp: string, extension = 'json'): string {
  const dir = resultSpoolDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // `mkdir` applies its mode only when it creates the directory, so a spool
  // directory left behind by an older build would keep its looser permissions.
  try {
    chmodSync(dir, 0o700);
  } catch {
    // A directory owned by another user stays as it is; the 0600 files still bound exposure.
  }
  return join(dir, `${operation}-${stamp}-${randomUUID().slice(0, 8)}.${extension}`);
}

export function spoolFullResult(operation: string, payload: unknown): string | null {
  try {
    const body = `${JSON.stringify(payload, null, 2)}\n`;
    const path = spoolFilePath(operation, createHash('sha256').update(body).digest('hex').slice(0, 16));
    writeFileSync(path, body, { mode: 0o600 });
    return path;
  } catch {
    return null;
  }
}
