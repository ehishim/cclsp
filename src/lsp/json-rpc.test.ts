import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspToolOutcomeError } from './capabilities.js';
import { JsonRpcTransport } from './json-rpc.js';
import type { LSPMessage } from './types.js';

/**
 * Build the exact bytes a server writes for one message. Content-Length is a BYTE
 * count, so a body carrying multi-byte characters is longer than its string length.
 */
function frameBytes(message: LSPMessage): Buffer {
  const content = JSON.stringify(message);
  return Buffer.from(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`, 'utf8');
}

/**
 * Create a mock ChildProcess with emittable stdout and writable stdin.
 */
function createMockProcess() {
  const stdout = new EventEmitter();
  const stdinData: string[] = [];
  const stdin = {
    write: jest.fn((data: string) => {
      stdinData.push(data);
      return true;
    }),
  };

  const proc = {
    stdout,
    stdin,
    stderr: new EventEmitter(),
  } as unknown as ChildProcess;

  return {
    process: proc,
    stdout,
    stdin,
    stdinData,
    /** Simulate the server sending a Content-Length framed message */
    simulateResponse(message: LSPMessage) {
      stdout.emit('data', frameBytes(message));
    },
    /** Simulate the server writing exact bytes, split at the given byte offsets */
    simulateBytes(bytes: Buffer, ...splitAt: number[]) {
      const offsets = [0, ...splitAt, bytes.length];
      for (let i = 0; i < offsets.length - 1; i++) {
        const start = offsets[i] as number;
        const end = offsets[i + 1] as number;
        if (end > start) stdout.emit('data', bytes.subarray(start, end));
      }
    },
  };
}

describe('JsonRpcTransport', () => {
  let mock: ReturnType<typeof createMockProcess>;
  let messageHandler: ReturnType<typeof jest.fn>;
  let transport: JsonRpcTransport;

  beforeEach(() => {
    mock = createMockProcess();
    messageHandler = jest.fn();
    transport = new JsonRpcTransport(mock.process, messageHandler);
  });

  describe('sendMessage', () => {
    it('writes Content-Length framed JSON to stdin', () => {
      const message: LSPMessage = {
        jsonrpc: '2.0',
        method: 'test',
        params: {},
      };
      transport.sendMessage(message);

      expect(mock.stdin.write).toHaveBeenCalledTimes(1);
      const written = mock.stdinData[0] as string;
      expect(written).toContain('Content-Length:');
      expect(written).toContain('"jsonrpc":"2.0"');
      expect(written).toContain('"method":"test"');
    });

    it('calculates Content-Length correctly for multi-byte characters', () => {
      const message: LSPMessage = {
        jsonrpc: '2.0',
        method: 'test',
        params: { text: '\u00e9' },
      };
      transport.sendMessage(message);

      const written = mock.stdinData[0] as string;
      const content = JSON.stringify(message);
      const expectedLength = Buffer.byteLength(content);
      expect(written).toContain(`Content-Length: ${expectedLength}`);
    });
  });

  describe('sendNotification', () => {
    it('sends JSON-RPC notification without id', () => {
      transport.sendNotification('textDocument/didOpen', {
        uri: 'file:///a.ts',
      });

      const written = mock.stdinData[0] as string;
      expect(written).toContain('"jsonrpc":"2.0"');
      expect(written).toContain('"method":"textDocument/didOpen"');
      expect(written).not.toContain('"id"');
    });
  });

  describe('sendRequest and response correlation', () => {
    it('resolves promise when matching response arrives', async () => {
      const promise = transport.sendRequest('textDocument/definition', {
        uri: 'file:///a.ts',
      });

      // Parse the sent message to get the ID
      const written = mock.stdinData[0] as string;
      const contentStart = written.indexOf('{');
      const sent = JSON.parse(written.substring(contentStart)) as LSPMessage;

      // Simulate server response with matching ID
      mock.simulateResponse({
        jsonrpc: '2.0',
        id: sent.id,
        result: [{ uri: 'file:///b.ts', range: {} }],
      });

      const result = await promise;
      expect(result).toEqual([{ uri: 'file:///b.ts', range: {} }]);
    });

    it('rejects promise when error response arrives', async () => {
      const promise = transport.sendRequest('textDocument/definition', {});

      const written = mock.stdinData[0] as string;
      const contentStart = written.indexOf('{');
      const sent = JSON.parse(written.substring(contentStart)) as LSPMessage;

      mock.simulateResponse({
        jsonrpc: '2.0',
        id: sent.id,
        error: { code: -32600, message: 'Invalid Request' },
      });

      expect(promise).rejects.toThrow('Invalid Request');
    });

    it('rejects promise on timeout', async () => {
      const promise = transport.sendRequest('slow/method', {}, 50);

      expect(promise).rejects.toThrow('LSP request timeout: slow/method (50ms)');
    });

    it('assigns unique IDs to each request', () => {
      transport.sendRequest('method1', {});
      transport.sendRequest('method2', {});

      const raw1 = mock.stdinData[0] as string;
      const raw2 = mock.stdinData[1] as string;
      const msg1 = JSON.parse(raw1.substring(raw1.indexOf('{')));
      const msg2 = JSON.parse(raw2.substring(raw2.indexOf('{')));

      expect(msg1.id).not.toBe(msg2.id);
    });
  });

  describe('incoming message handling', () => {
    it('delegates notifications to message handler', () => {
      mock.simulateResponse({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: { uri: 'file:///a.ts', diagnostics: [] },
      });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect(messageHandler).toHaveBeenCalledWith(
        expect.objectContaining({
          method: 'textDocument/publishDiagnostics',
        })
      );
    });

    it('handles split messages across multiple data events', () => {
      const message: LSPMessage = {
        jsonrpc: '2.0',
        method: 'notification',
        params: {},
      };
      const content = JSON.stringify(message);
      const frame = `Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`;

      // Split the frame into two parts
      const mid = Math.floor(frame.length / 2);
      mock.stdout.emit('data', Buffer.from(frame.substring(0, mid)));
      mock.stdout.emit('data', Buffer.from(frame.substring(mid)));

      expect(messageHandler).toHaveBeenCalledTimes(1);
    });

    it('delivers a body carrying multi-byte characters instead of stalling', () => {
      // The real repro: a hover response whose docblock contains an em dash and an
      // arrow. Measured against a string buffer, the frame is 4 bytes short of its
      // declared Content-Length, so the completeness check stayed false forever.
      const text = 'Revokes every token \u2014 the session ends \u2192 nothing resumes';
      mock.simulateResponse({
        jsonrpc: '2.0',
        method: 'window/logMessage',
        params: { text },
      });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      const received = messageHandler.mock.calls[0]?.[0] as LSPMessage;
      expect((received.params as { text: string }).text).toBe(text);
    });

    it('resolves a pending request whose response carries non-ASCII prose', async () => {
      const promise = transport.sendRequest('textDocument/hover', {});
      const written = mock.stdinData[0] as string;
      const sent = JSON.parse(written.substring(written.indexOf('{'))) as LSPMessage;

      const value = '```php\npublic function revoke(): void\n```\n\u2014 invalidates \u2192 all';
      mock.simulateResponse({
        jsonrpc: '2.0',
        id: sent.id,
        result: { contents: { kind: 'markdown', value } },
      });

      const result = (await promise) as { contents: { value: string } };
      expect(result.contents.value).toBe(value);
    });

    it('decodes a multi-byte character split across two data events', () => {
      const text = 'before \u2014 after';
      const bytes = frameBytes({ jsonrpc: '2.0', method: 'notification', params: { text } });
      // Split strictly inside the em dash: its three UTF-8 bytes straddle the writes,
      // so decoding each chunk on arrival would corrupt the character.
      const emDashStart = bytes.indexOf(Buffer.from('\u2014', 'utf8'));
      expect(emDashStart).toBeGreaterThan(0);
      mock.simulateBytes(bytes, emDashStart + 1);

      expect(messageHandler).toHaveBeenCalledTimes(1);
      const received = messageHandler.mock.calls[0]?.[0] as LSPMessage;
      expect((received.params as { text: string }).text).toBe(text);
    });

    it('keeps framing later messages after a multi-byte body', () => {
      // The desync this guards: undelivered bytes left at the head of the buffer
      // slice every later response against a stale header for the life of the server.
      mock.simulateResponse({
        jsonrpc: '2.0',
        method: 'first',
        params: { text: '\u2014\u2192\u00e9\u{1f600}' },
      });
      mock.simulateResponse({ jsonrpc: '2.0', method: 'second', params: {} });
      mock.simulateResponse({ jsonrpc: '2.0', method: 'third', params: {} });

      expect(messageHandler).toHaveBeenCalledTimes(3);
      expect((messageHandler.mock.calls[2]?.[0] as LSPMessage).method).toBe('third');
    });

    it('costs one message when a body cannot be parsed', () => {
      const broken = '{"jsonrpc":"2.0",';
      mock.stdout.emit(
        'data',
        Buffer.from(`Content-Length: ${Buffer.byteLength(broken)}\r\n\r\n${broken}`, 'utf8')
      );
      mock.simulateResponse({ jsonrpc: '2.0', method: 'after', params: {} });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect((messageHandler.mock.calls[0]?.[0] as LSPMessage).method).toBe('after');
    });

    it('costs one header block when Content-Length is absent or unusable', () => {
      mock.stdout.emit('data', Buffer.from('X-Trace: 1\r\n\r\n', 'utf8'));
      mock.stdout.emit('data', Buffer.from(`Content-Length: ${'9'.repeat(40)}\r\n\r\n`, 'utf8'));
      mock.simulateResponse({ jsonrpc: '2.0', method: 'after', params: {} });

      expect(messageHandler).toHaveBeenCalledTimes(1);
      expect((messageHandler.mock.calls[0]?.[0] as LSPMessage).method).toBe('after');
    });

    it('does not abandon frames buffered behind a throwing handler', () => {
      const local = createMockProcess();
      const seen: string[] = [];
      const throwing = jest.fn((message: LSPMessage) => {
        seen.push(message.method as string);
        if (message.method === 'boom') throw new Error('handler exploded');
      });
      new JsonRpcTransport(local.process, throwing);

      const both = Buffer.concat([
        frameBytes({ jsonrpc: '2.0', method: 'boom', params: {} }),
        frameBytes({ jsonrpc: '2.0', method: 'survivor', params: {} }),
      ]);
      local.stdout.emit('data', both);

      expect(seen).toEqual(['boom', 'survivor']);
    });

    it('handles multiple messages in a single data event', () => {
      const msg1: LSPMessage = { jsonrpc: '2.0', method: 'notif1', params: {} };
      const msg2: LSPMessage = { jsonrpc: '2.0', method: 'notif2', params: {} };
      const content1 = JSON.stringify(msg1);
      const content2 = JSON.stringify(msg2);
      const frame =
        `Content-Length: ${Buffer.byteLength(content1)}\r\n\r\n${content1}` +
        `Content-Length: ${Buffer.byteLength(content2)}\r\n\r\n${content2}`;

      mock.stdout.emit('data', Buffer.from(frame));

      expect(messageHandler).toHaveBeenCalledTimes(2);
    });
  });

  describe('rejectAllPending', () => {
    it('rejects all outstanding requests', async () => {
      const p1 = transport.sendRequest('method1', {}, 5000);
      const p2 = transport.sendRequest('method2', {}, 5000);

      transport.rejectAllPending('Server crashed');

      expect(p1).rejects.toThrow('Server crashed');
      expect(p2).rejects.toThrow('Server crashed');
    });

    it('does nothing when no requests are pending', () => {
      // Should not throw
      transport.rejectAllPending('No-op');
    });
  });

  describe('over-bound response bodies', () => {
    const spoolDir = mkdtempSync(join(tmpdir(), 'cclsp-ingress-'));
    const previousDir = process.env.CCLSP_RESULT_DIR;
    const previousBound = process.env.CCLSP_LSP_MAX_MESSAGE_BYTES;

    beforeEach(() => {
      process.env.CCLSP_RESULT_DIR = spoolDir;
      process.env.CCLSP_LSP_MAX_MESSAGE_BYTES = '2048';
    });

    afterEach(() => {
      if (previousDir === undefined) delete process.env.CCLSP_RESULT_DIR;
      else process.env.CCLSP_RESULT_DIR = previousDir;
      if (previousBound === undefined) delete process.env.CCLSP_LSP_MAX_MESSAGE_BYTES;
      else process.env.CCLSP_LSP_MAX_MESSAGE_BYTES = previousBound;
      rmSync(spoolDir, { recursive: true, force: true });
    });

    it('streams an over-bound body to a spool file and returns a typed pointer', async () => {
      const pending = transport.sendRequest('textDocument/documentSymbol', {}, 5000);
      const rows = Array.from({ length: 400 }, (_, index) => ({ name: `symbol${index}`, detail: 'x'.repeat(60) }));
      const content = JSON.stringify({ jsonrpc: '2.0', id: 1, result: rows });
      expect(Buffer.byteLength(content)).toBeGreaterThan(2048);
      const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`, 'utf8');

      // Split mid-body: the transport must never hold the whole body in memory.
      mock.simulateBytes(bytes, 64, 900, 4_000);

      const error = await pending.then(() => null, (reason) => reason);
      expect(error).toBeInstanceOf(LspToolOutcomeError);
      const outcome = (error as LspToolOutcomeError).outcome;
      expect(outcome).toMatchObject({ outcome: 'too-large', code: 'LSP_RESPONSE_SPOOLED' });
      expect(outcome.bytes).toBe(Buffer.byteLength(content));
      expect(outcome.recovery).toContain(outcome.resultFile as string);
      const spooled = JSON.parse(readFileSync(outcome.resultFile as string, 'utf8'));
      expect(spooled.result).toHaveLength(400);
    });

    it('correlates a response whose id follows a large result', async () => {
      const pending = transport.sendRequest('textDocument/references', {}, 5000);
      // Real servers emit the id after the payload; a head-only scan would miss it
      // and leave this request to time out.
      const content = `{"jsonrpc":"2.0","result":${JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ uri: `file:///src/f${i}.ts`, detail: 'z'.repeat(40) })))},"id":1}`;
      expect(Buffer.byteLength(content)).toBeGreaterThan(2048);
      const bytes = Buffer.from(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`, 'utf8');
      mock.simulateBytes(bytes, 40, 700, 5_000);

      const error = await pending.then(() => null, (reason) => reason);
      expect(error).toBeInstanceOf(LspToolOutcomeError);
      expect((error as LspToolOutcomeError).outcome).toMatchObject({
        outcome: 'too-large', code: 'LSP_RESPONSE_SPOOLED',
      });
    });

    it('correlates each oversized response to its own concurrent request', async () => {
      const first = transport.sendRequest('textDocument/references', {}, 5000);
      const second = transport.sendRequest('textDocument/documentSymbol', {}, 5000);
      // Distinct row counts per id, so the rejected byte size proves WHICH request
      // each spooled body reached rather than only that both were rejected. Every
      // row also carries the id of the OTHER pending request: a text match would
      // find it first and reject the wrong caller.
      const payload = (id: number) =>
        `{"jsonrpc":"2.0","id":${id},"result":${JSON.stringify(Array.from({ length: id === 1 ? 200 : 300 }, () => ({ nested: { id: id === 1 ? 2 : 1 }, pad: 'q'.repeat(30) })))}}`;

      for (const id of [2, 1]) {
        const content = payload(id);
        mock.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`, 'utf8'));
      }

      const secondError = await second.then(() => null, (reason) => reason);
      const firstError = await first.then(() => null, (reason) => reason);
      expect(secondError).toBeInstanceOf(LspToolOutcomeError);
      expect(firstError).toBeInstanceOf(LspToolOutcomeError);
      const files = [firstError, secondError].map((error) => (error as LspToolOutcomeError).outcome.resultFile);
      expect(new Set(files).size).toBe(2);
      expect((firstError as LspToolOutcomeError).outcome.bytes).toBe(Buffer.byteLength(payload(1)));
      expect((secondError as LspToolOutcomeError).outcome.bytes).toBe(Buffer.byteLength(payload(2)));
    });

    it('rejects only the answered request when the payload names another pending id', async () => {
      const first = transport.sendRequest('textDocument/references', {}, 5000);
      let firstSettled = false;
      void first.then(() => { firstSettled = true; }, () => { firstSettled = true; });
      const second = transport.sendRequest('textDocument/documentSymbol', {}, 5000);

      // The response to request 2 carries request 1's id inside its own result,
      // AFTER its real id, so neither a first-match nor a last-match text scan
      // can pass this case.
      const content = `{"jsonrpc":"2.0","id":2,"result":${JSON.stringify(Array.from({ length: 300 }, () => ({ id: 1, pad: 'r'.repeat(30) })))}}`;
      mock.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`, 'utf8'));

      const error = await second.then(() => null, (reason) => reason);
      expect(error).toBeInstanceOf(LspToolOutcomeError);
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(firstSettled).toBe(false);

      // Request 1 is still pending and still correlatable by its own answer.
      mock.simulateResponse({ jsonrpc: '2.0', id: 1, result: ['small'] });
      await expect(first).resolves.toEqual(['small']);
    });

    it('leaves every caller alone when an oversized frame answers nothing', async () => {
      const pending = transport.sendRequest('textDocument/references', {}, 5000);
      let settled = false;
      void pending.then(() => { settled = true; }, () => { settled = true; });

      // A notification, and then a server-initiated request: neither answers a
      // caller, so neither may reject the sole outstanding request.
      for (const frame of [
        { jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'z'.repeat(4096), id: 1 } },
        { jsonrpc: '2.0', id: 1, method: 'workspace/applyEdit', params: { edit: 'y'.repeat(4096) } },
      ]) {
        const content = JSON.stringify(frame);
        mock.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(content)}\r\n\r\n${content}`, 'utf8'));
      }

      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(settled).toBe(false);
      mock.simulateResponse({ jsonrpc: '2.0', id: 1, result: ['own answer'] });
      await expect(pending).resolves.toEqual(['own answer']);
    });

    it('resynchronizes on the next frame after an over-bound body', async () => {
      const pending = transport.sendRequest('textDocument/documentSymbol', {}, 5000);
      const big = JSON.stringify({ jsonrpc: '2.0', id: 1, result: 'y'.repeat(4096) });
      mock.stdout.emit('data', Buffer.from(`Content-Length: ${Buffer.byteLength(big)}\r\n\r\n${big}`, 'utf8'));
      await pending.then(() => null, () => null);

      mock.simulateResponse({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'alive' } });
      expect(messageHandler).toHaveBeenCalledTimes(1);
    });

    it('drops an unterminated header block instead of buffering it forever', () => {
      mock.stdout.emit('data', Buffer.from('Content-Length: 10'.padEnd(70_000, ' '), 'utf8'));
      mock.simulateResponse({ jsonrpc: '2.0', method: 'window/logMessage', params: { message: 'alive' } });
      expect(messageHandler).toHaveBeenCalledTimes(1);
    });
  });
});
