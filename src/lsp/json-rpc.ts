import type { ChildProcess } from 'node:child_process';
import { closeSync, openSync, writeSync } from 'node:fs';
import { logger } from '../logger.js';
import { spoolFilePath } from '../result-spool.js';
import { LspToolOutcomeError } from './capabilities.js';
import { TopLevelResponseIdScanner } from './top-level-id-scanner.js';
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
const DEFAULT_MAX_MESSAGE_BYTES = 8 * 1024 * 1024;
const MAX_HEADER_BYTES = 64 * 1024;

function maxMessageBytes(): number {
  const configured = Number.parseInt(process.env.CCLSP_LSP_MAX_MESSAGE_BYTES ?? '', 10);
  return Number.isSafeInteger(configured) && configured > 0
    ? configured
    : DEFAULT_MAX_MESSAGE_BYTES;
}

/** One frame being streamed to disk because it is too large to hold in memory. */
interface OversizedFrame {
  remaining: number;
  total: number;
  /** Null when the body could not be persisted; its bytes are then skipped to resynchronize. */
  path: string | null;
  fd: number | null;
  /** Structural scan that yields only this frame's own top-level response id. */
  scanner: TopLevelResponseIdScanner;
}

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

  /**
   * Set while an over-bound response body is written straight to a spool file.
   * The transport then holds at most one stdout chunk plus a bounded head, so a
   * provider answer can never be materialized — or JSON-parsed — into memory
   * above the ingress bound, and the complete bytes still reach the caller
   * through the returned path.
   */
  private oversized: OversizedFrame | null = null;

  constructor(
    private readonly process: ChildProcess,
    private readonly onMessage: MessageHandler,
    private readonly serverLabel = 'lsp'
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
      if (this.oversized) {
        if (!this.consumeOversized()) return;
        continue;
      }

      const headerEndIndex = this.buffer.indexOf(HEADER_TERMINATOR);
      if (headerEndIndex === -1) {
        if (this.buffer.length > MAX_HEADER_BYTES) {
          // A peer that never terminates a header must not grow this process.
          logger.error(`Dropping ${this.buffer.length} unframed LSP bytes: no header terminator\n`);
          this.buffer = Buffer.alloc(0);
        }
        return;
      }

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

      if (contentLength > maxMessageBytes()) {
        this.buffer = this.buffer.subarray(bodyStart);
        this.beginOversized(contentLength);
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
   * Start streaming an over-bound body to its own spool file. Failing to open one
   * is not fatal: the bytes are still consumed so the transport resynchronizes,
   * and the caller receives the same typed outcome without a path.
   */
  private beginOversized(contentLength: number): void {
    let path: string | null = null;
    let fd: number | null = null;
    try {
      path = spoolFilePath('lsp_response', String(Date.now()), 'json');
      fd = openSync(path, 'w', 0o600);
    } catch (error) {
      logger.error(`Failed to open an LSP response spool file: ${error}\n`);
      path = null;
      fd = null;
    }
    this.oversized = {
      remaining: contentLength,
      total: contentLength,
      path,
      fd,
      scanner: new TopLevelResponseIdScanner(),
    };
  }

  /** Returns true once the whole over-bound body has been consumed. */
  private consumeOversized(): boolean {
    const frame = this.oversized;
    if (!frame) return true;
    if (this.buffer.length === 0) return false;

    const take = Math.min(frame.remaining, this.buffer.length);
    const chunk = this.buffer.subarray(0, take);
    this.buffer = this.buffer.subarray(take);
    frame.remaining -= take;
    if (frame.fd !== null) {
      try {
        writeSync(frame.fd, chunk);
      } catch (error) {
        logger.error(`Failed to spool an LSP response body: ${error}\n`);
        try {
          closeSync(frame.fd);
        } catch {}
        frame.fd = null;
        frame.path = null;
      }
    }
    frame.scanner.push(chunk);
    if (frame.remaining > 0) return false;

    this.finishOversized(frame);
    return true;
  }

  /**
   * Reject only the request this frame actually answers. Correlation uses the
   * frame's structural top-level `id`, so an id inside a `result` payload cannot
   * reject another in-flight request, and an oversized notification or
   * server-initiated request — which answers nothing — leaves every caller alone
   * to finish or time out on its own terms.
   */
  private finishOversized(frame: OversizedFrame): void {
    this.oversized = null;
    if (frame.fd !== null) {
      try {
        closeSync(frame.fd);
      } catch (error) {
        logger.error(`Failed to close an LSP response spool file: ${error}\n`);
      }
    }
    const id = frame.scanner.responseId;
    const request = id !== null ? this.pendingRequests.get(id) : undefined;
    if (id === null || !request) {
      logger.error(
        `Spooled a ${frame.total}-byte oversized LSP frame that answers no pending request${frame.path ? ` at ${frame.path}` : ''}\n`
      );
      return;
    }
    this.pendingRequests.delete(id);
    const recovery = frame.path
      ? `Read or grep the complete response at ${frame.path}, or narrow the request.`
      : 'Narrow the request; the oversized response could not be spooled.';
    request.reject(
      new LspToolOutcomeError({
        outcome: 'too-large',
        code: 'LSP_RESPONSE_SPOOLED',
        method: 'textDocument/*',
        server: this.serverLabel,
        reason: `the response body is ${frame.total} bytes, above the ${maxMessageBytes()}-byte ingress bound`,
        ...(frame.path ? { resultFile: frame.path } : {}),
        bytes: frame.total,
        recovery,
      })
    );
  }

  /**
   * Handle an incoming message: correlate responses, delegate the rest.
   */
  private handleIncoming(message: LSPMessage): void {
    // Request ids are independent in each direction; a server request can reuse
    // an id that this client is still waiting for.
    if (message.method !== undefined) {
      this.onMessage(message);
      return;
    }
    if (!('result' in message) && !('error' in message)) return;

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
