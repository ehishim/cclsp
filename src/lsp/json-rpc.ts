import type { ChildProcess } from 'node:child_process';
import { logger } from '../logger.js';
import type { LSPMessage } from './types.js';

/**
 * Callback for incoming messages that are NOT response correlations.
 * These are server-initiated notifications and requests.
 */
export type MessageHandler = (message: LSPMessage) => void;

/** LSP header/body separator. Bytes, so the offset it yields indexes the byte buffer. */
const HEADER_TERMINATOR = Buffer.from('\r\n\r\n', 'latin1');

/**
 * JSON-RPC 2.0 transport over stdio with Content-Length framing.
 *
 * Handles:
 * - Content-Length message framing (send and receive)
 * - JSON-RPC 2.0 encoding/decoding
 * - Request/response correlation via ID tracking
 * - Timeout management for pending requests
 *
 * Does NOT handle LSP semantics (initialization, adapters, diagnostics).
 */
export class JsonRpcTransport {
  private nextId = 1;
  private pendingRequests: Map<
    number,
    { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }
  > = new Map();
  /**
   * Incoming stdout bytes awaiting framing.
   *
   * Bytes, never a string: `Content-Length` counts BYTES while a JS string counts
   * UTF-16 code units, so a body carrying any multi-byte character measures short
   * and its completeness check stays false with the whole message already received.
   * Holding raw bytes also lets a UTF-8 sequence straddle two stdout writes.
   */
  private buffer: Buffer = Buffer.alloc(0);

  constructor(
    private readonly process: ChildProcess,
    private readonly onMessage: MessageHandler
  ) {
    this.setupStdoutHandler();
  }

  /**
   * Set up the stdout data handler for Content-Length framing.
   * Parses incoming data into complete JSON-RPC messages.
   */
  private setupStdoutHandler(): void {
    this.process.stdout?.on('data', (data: Buffer | string) => {
      const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drainFrames();
    });
  }

  /**
   * Consume every complete frame currently buffered.
   *
   * Each iteration either advances past exactly one frame or returns to await more
   * bytes, so an unframeable message costs one message rather than desynchronizing
   * the transport for the life of the server: undelivered bytes left at the head of
   * the buffer would slice every later response against a stale header.
   */
  private drainFrames(): void {
    while (true) {
      const headerEndIndex = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEndIndex === -1) return;

      const bodyStart = headerEndIndex + HEADER_TERMINATOR.length;
      // Headers are ASCII per the LSP specification; latin1 maps bytes 1:1, so a
      // non-ASCII byte cannot be folded into a digit the way 'ascii' truncation would.
      const headerPart = this.buffer.toString('latin1', 0, headerEndIndex);
      const contentLengthMatch = headerPart.match(/Content-Length: (\d+)/);
      const contentLength = contentLengthMatch?.[1]
        ? Number.parseInt(contentLengthMatch[1], 10)
        : Number.NaN;

      if (!Number.isSafeInteger(contentLength)) {
        // Missing or unusable length: drop this header block only and resynchronize
        // on the next one. Retaining it would stall the buffer permanently.
        this.buffer = this.buffer.subarray(bodyStart);
        continue;
      }

      if (this.buffer.length < bodyStart + contentLength) return;

      const messageContent = this.buffer.toString('utf8', bodyStart, bodyStart + contentLength);
      this.buffer = this.buffer.subarray(bodyStart + contentLength);

      let message: LSPMessage;
      try {
        message = JSON.parse(messageContent);
      } catch (error) {
        logger.error(`Failed to parse LSP message: ${error}\n`);
        continue;
      }

      try {
        this.handleIncoming(message);
      } catch (error) {
        // A throwing consumer must not abandon frames already buffered behind it.
        logger.error(`Failed to dispatch LSP message: ${error}\n`);
      }
    }
  }

  /**
   * Handle an incoming message: correlate responses, delegate the rest.
   */
  private handleIncoming(message: LSPMessage): void {
    // Response correlation: match responses to pending requests
    // Use !== undefined to handle id: 0 (valid JSON-RPC id)
    if (message.id !== undefined && this.pendingRequests.has(message.id)) {
      const request = this.pendingRequests.get(message.id);
      if (!request) return;
      const { resolve, reject } = request;
      this.pendingRequests.delete(message.id);

      if (message.error) {
        reject(new Error(message.error.message || 'LSP Error'));
      } else {
        resolve(message.result);
      }
    }

    // Delegate notifications and server-initiated requests to the handler
    if (message.method) {
      this.onMessage(message);
    }
  }

  /**
   * Send a raw LSP message with Content-Length framing.
   */
  sendMessage(message: LSPMessage): void {
    const content = JSON.stringify(message);
    const header = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n`;
    this.process.stdin?.write(header + content);
  }

  /**
   * Send a JSON-RPC request and wait for the correlated response.
   * Returns a promise that resolves with the result or rejects on error/timeout.
   */
  sendRequest(method: string, params: unknown, timeout = 30000): Promise<unknown> {
    const id = this.nextId++;
    const message: LSPMessage = {
      jsonrpc: '2.0',
      id,
      method,
      params,
    };

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(id);
        reject(new Error(`LSP request timeout: ${method} (${timeout}ms)`));
      }, timeout);

      this.pendingRequests.set(id, {
        resolve: (value: unknown) => {
          clearTimeout(timeoutId);
          resolve(value);
        },
        reject: (reason?: unknown) => {
          clearTimeout(timeoutId);
          reject(reason);
        },
      });

      this.sendMessage(message);
    });
  }

  /**
   * Reject all pending requests. Called when the server process exits unexpectedly.
   */
  rejectAllPending(reason: string): void {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const { reject } of pending) {
      reject(new Error(reason));
    }
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  sendNotification(method: string, params: unknown): void {
    const message: LSPMessage = {
      jsonrpc: '2.0',
      method,
      params,
    };
    this.sendMessage(message);
  }
}
