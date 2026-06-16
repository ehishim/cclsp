// CLI-side transport: connect to the daemon over its Unix socket, auto-spawning
// the daemon (detached) the first time if it isn't running yet.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { type Socket, connect } from 'node:net';
import { SOCKET_PATH } from './config.js';
import { type HubResponse, createLineReader, writeMessage } from './protocol.js';

let reqId = 0;

function tryConnect(): Promise<Socket> {
  return new Promise((res, rej) => {
    const sock = connect(SOCKET_PATH);
    sock.once('connect', () => res(sock));
    sock.once('error', rej);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getConnection(autoStart: boolean): Promise<Socket> {
  try {
    return await tryConnect();
  } catch {
    if (!autoStart) throw new Error('cclsp-hub daemon is not running');
  }
  // Re-exec this same script in daemon mode, fully detached.
  const entry = process.argv[1];
  spawn(process.execPath, [entry, '--daemon'], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  }).unref();

  for (let i = 0; i < 100; i++) {
    await sleep(100);
    if (existsSync(SOCKET_PATH)) {
      try {
        return await tryConnect();
      } catch {
        // socket file exists but not accepting yet — keep waiting
      }
    }
  }
  throw new Error('failed to start cclsp-hub daemon (timed out waiting for its socket)');
}

export async function request(
  cmd: string,
  args: Record<string, unknown> = {},
  opts: { autoStart?: boolean } = {},
): Promise<unknown> {
  const sock = await getConnection(opts.autoStart ?? true);
  const id = ++reqId;
  return new Promise((res, rej) => {
    sock.on(
      'data',
      createLineReader((msg: HubResponse) => {
        if (msg.id !== id) return;
        sock.end();
        if (msg.ok) res(msg.result);
        else rej(new Error(msg.error || 'request failed'));
      }),
    );
    sock.on('error', rej);
    writeMessage(sock, { id, cmd, args });
  });
}

// Read-only convenience: returns null instead of starting a daemon.
export async function tryRequest(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  try {
    return await request(cmd, args, { autoStart: false });
  } catch {
    return null;
  }
}
