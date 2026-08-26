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

export const DEFAULT_MAX_FRAME_BYTES = 8 * 1024 * 1024;

export interface LineReaderOptions {
  maxFrameBytes?: number;
  onOverflow?: (bytes: number, limit: number) => void;
}

// Returns a `data` handler that buffers partial chunks and invokes `onMessage`
// once per complete line. The pending buffer is bounded, so a peer that never
// terminates a frame cannot grow this process without limit; an oversized frame
// is reported through `onOverflow` and skipped instead of being parsed.
export function createLineReader(
  onMessage: (obj: any) => void,
  options: LineReaderOptions = {},
): (chunk: Buffer) => void {
  const limit = options.maxFrameBytes && options.maxFrameBytes > 0
    ? options.maxFrameBytes
    : DEFAULT_MAX_FRAME_BYTES;
  let buffer = '';
  let discardingFrame = false;
  return (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    let nl = buffer.indexOf('\n');
    while (nl !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (discardingFrame) {
        discardingFrame = false;
      } else if (line.trim().length > 0) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // ignore a malformed line rather than tearing down the connection
        }
      }
      nl = buffer.indexOf('\n');
    }
    const pending = Buffer.byteLength(buffer, 'utf8');
    if (pending > limit) {
      options.onOverflow?.(pending, limit);
      buffer = '';
      discardingFrame = true;
    }
  };
}
