// Tiny newline-delimited-JSON protocol spoken between the CLI client and the
// daemon over a Unix domain socket. One JSON object per line; JSON.stringify
// escapes embedded newlines, so a single object is always exactly one line.

import type { Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';

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
  let decoder = new StringDecoder('utf8');
  let buffer = '';
  let frameBytes = 0;
  let discardingFrame = false;
  return (chunk: Buffer) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      if (!discardingFrame) {
        frameBytes += end - offset;
        if (frameBytes > limit) {
          discardingFrame = true;
          buffer = '';
          decoder = new StringDecoder('utf8');
          options.onOverflow?.(frameBytes, limit);
        } else {
          buffer += decoder.write(chunk.subarray(offset, end));
        }
      }
      if (newline === -1) break;
      if (!discardingFrame) {
        const line = buffer + decoder.end();
        if (line.trim()) {
          try {
            onMessage(JSON.parse(line));
          } catch {
            // Malformed input costs one frame, not the connection.
          }
        }
      }
      buffer = '';
      frameBytes = 0;
      discardingFrame = false;
      decoder = new StringDecoder('utf8');
      offset = newline + 1;
    }
  };
}
