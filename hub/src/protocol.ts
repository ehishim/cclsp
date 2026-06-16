// Tiny newline-delimited-JSON protocol spoken between the CLI client and the
// daemon over a Unix domain socket. One JSON object per line; JSON.stringify
// escapes embedded newlines, so a single object is always exactly one line.

import type { Socket } from 'node:net';

export interface HubRequest {
  id: number;
  cmd: string;
  args?: Record<string, unknown>;
}

export interface HubResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export function writeMessage(sock: Socket, msg: unknown): void {
  sock.write(`${JSON.stringify(msg)}\n`);
}

// Returns a `data` handler that buffers partial chunks and invokes `onMessage`
// once per complete line.
export function createLineReader(onMessage: (obj: any) => void): (chunk: Buffer) => void {
  let buffer = '';
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (line.trim().length > 0) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // ignore a malformed line rather than tearing down the connection
        }
      }
      nl = buffer.indexOf('\n');
    }
  };
}
