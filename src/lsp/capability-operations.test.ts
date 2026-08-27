import { describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspToolOutcomeError } from './capabilities.js';
import { DiagnosticsCache } from './diagnostics.js';
import { DocumentManager } from './document-manager.js';
import {
  findTypeDefinition,
  getCompletions,
  getDiagnosticsBatch,
  getDocumentSymbols,
  renameSymbol,
  resolveCompletionItem,
} from './operations.js';
import type { ServerState } from './types.js';

const TEST_FILE = join(tmpdir(), `cclsp-capability-${process.pid}.ts`);
writeFileSync(TEST_FILE, 'export const value = 1;\n');

function server(
  capabilities: Record<string, unknown>,
  sendRequest: ReturnType<typeof jest.fn>
): ServerState {
  return {
    serverCapabilities: capabilities,
    config: { extensions: ['ts'], command: ['fixture-ls'] },
    initializationPromise: Promise.resolve(),
    transport: {
      sendRequest,
      sendMessage: jest.fn(),
      sendNotification: jest.fn(),
      rejectAllPending: jest.fn(),
    },
    documentManager: {
      ensureOpen: jest.fn().mockResolvedValue(false),
      sendChange: jest.fn(),
      isOpen: jest.fn().mockReturnValue(false),
      getVersion: jest.fn().mockReturnValue(1),
      getSyncSig: jest.fn(),
      setSyncSig: jest.fn(),
    },
    diagnosticsCache: {
      update: jest.fn(),
      get: jest.fn(),
      delete: jest.fn(),
      waitForIdle: jest.fn().mockResolvedValue(undefined),
      waitForAllIdle: jest.fn().mockResolvedValue(undefined),
    },
  } as unknown as ServerState;
}

describe('capability-gated operations', () => {
  it('does not send documentSymbol when the provider is absent', async () => {
    const sendRequest = jest.fn();
    const state = server({}, sendRequest);
    await expect(getDocumentSymbols(state, TEST_FILE)).rejects.toBeInstanceOf(LspToolOutcomeError);
    expect(sendRequest).not.toHaveBeenCalled();
    expect(state.documentManager.ensureOpen).not.toHaveBeenCalled();
  });

  it('normalizes type-definition links to their semantic target', async () => {
    const sendRequest = jest.fn().mockResolvedValue([
      {
        targetUri: 'file:///workspace/owner.ts',
        targetRange: { start: { line: 9, character: 0 }, end: { line: 12, character: 1 } },
        targetSelectionRange: {
          start: { line: 10, character: 17 },
          end: { line: 10, character: 40 },
        },
      },
    ]);
    const state = server({ typeDefinitionProvider: true }, sendRequest);
    state.documentManager.acquire = jest.fn().mockResolvedValue({
      justOpened: false,
      release: jest.fn(),
    });

    const result = await findTypeDefinition(state, TEST_FILE, { line: 0, character: 7 });

    expect(result).toEqual([
      {
        uri: 'file:///workspace/owner.ts',
        range: { start: { line: 10, character: 17 }, end: { line: 10, character: 40 } },
      },
    ]);
    expect(sendRequest).toHaveBeenCalledWith(
      'textDocument/typeDefinition',
      {
        textDocument: { uri: expect.stringContaining('cclsp-capability-') },
        position: { line: 0, character: 7 },
      },
      30000
    );
  });

  it('preserves a supported empty documentSymbol result', async () => {
    const sendRequest = jest.fn().mockResolvedValue([]);
    const result = await getDocumentSymbols(
      server({ documentSymbolProvider: true }, sendRequest),
      TEST_FILE
    );
    expect(result).toEqual([]);
    expect(sendRequest).toHaveBeenCalledWith(
      'textDocument/documentSymbol',
      expect.any(Object),
      30000
    );
  });

  it('refuses a rename when prepareRename declines and never sends rename', async () => {
    const sendRequest = jest.fn().mockResolvedValueOnce(null);
    const state = server({ renameProvider: { prepareProvider: true } }, sendRequest);
    await expect(
      renameSymbol(state, TEST_FILE, { line: 0, character: 13 }, 'renamed')
    ).rejects.toMatchObject({
      outcome: {
        outcome: 'rejected',
        code: 'LSP_RENAME_REJECTED',
        method: 'textDocument/prepareRename',
      },
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(sendRequest.mock.calls[0]?.[0]).toBe('textDocument/prepareRename');
  });

  it('preserves the server reason when prepareRename returns an error', async () => {
    const sendRequest = jest
      .fn()
      .mockRejectedValueOnce(new Error('You cannot rename this element.'));
    const state = server({ renameProvider: { prepareProvider: true } }, sendRequest);
    await expect(
      renameSymbol(state, TEST_FILE, { line: 0, character: 0 }, 'renamed')
    ).rejects.toMatchObject({
      outcome: {
        outcome: 'rejected',
        code: 'LSP_RENAME_REJECTED',
        reason: 'You cannot rename this element.',
      },
    });
    expect(sendRequest).toHaveBeenCalledTimes(1);
  });

  it('resolves completion items only when the server declares resolveProvider', async () => {
    const item = { label: 'value', data: { id: 1 } };
    const unsupportedRequest = jest.fn();
    expect(await resolveCompletionItem(server({}, unsupportedRequest), item, 10)).toEqual(item);
    expect(unsupportedRequest).not.toHaveBeenCalled();

    const supportedRequest = jest.fn().mockResolvedValue({ documentation: 'Resolved docs' });
    expect(
      await resolveCompletionItem(
        server({ completionProvider: { resolveProvider: true } }, supportedRequest),
        item,
        10
      )
    ).toEqual({ ...item, documentation: 'Resolved docs' });
    expect(supportedRequest).toHaveBeenCalledWith('completionItem/resolve', item, 10);
  });

  it('keeps the original completion item when resolve times out', async () => {
    const item = { label: 'slow' };
    const sendRequest = jest.fn().mockImplementation(() => new Promise(() => undefined));
    const result = await resolveCompletionItem(
      server({ completionProvider: { resolveProvider: true } }, sendRequest),
      item,
      5
    );
    expect(result).toEqual(item);
  });

  it('restores exact document content after synthetic completion success, timeout, and cancellation', async () => {
    const original = 'export const target = value;\n';
    writeFileSync(TEST_FILE, original);
    const notifications: Array<[string, unknown]> = [];
    const sendNotification = jest.fn((method: string, params: unknown) => {
      notifications.push([method, params]);
    });
    const sendRequest = jest.fn().mockResolvedValue([{ label: 'member' }]);
    const transport = {
      sendRequest,
      sendMessage: jest.fn(),
      sendNotification,
      rejectAllPending: jest.fn(),
    };
    const state = server({ completionProvider: {} }, sendRequest);
    state.transport = transport as never;
    state.documentManager = new DocumentManager(transport as never, 10);

    const result = await getCompletions(
      state,
      TEST_FILE,
      { line: 0, character: 19 },
      undefined,
      true
    );
    expect(result).toMatchObject({ syntheticTrigger: true, items: [{ label: 'member' }] });
    expect(state.documentManager.getText(TEST_FILE)).toBe(original);
    expect(state.documentManager.getVersion(TEST_FILE)).toBe(3);
    const changes = notifications
      .filter(([method]) => method === 'textDocument/didChange')
      .map(
        ([, params]) =>
          (params as { contentChanges: Array<{ text: string }> }).contentChanges[0]?.text
      );
    expect(changes).toEqual(['export const target. = value;\n', original]);

    for (const [message, version] of [
      ['request timed out', 5],
      ['request cancelled', 7],
    ] as const) {
      sendRequest.mockRejectedValueOnce(new Error(message));
      await expect(
        getCompletions(state, TEST_FILE, { line: 0, character: 19 }, undefined, true)
      ).rejects.toThrow(message);
      expect(state.documentManager.getText(TEST_FILE)).toBe(original);
      expect(state.documentManager.getVersion(TEST_FILE)).toBe(version);
    }
  });

  it('keeps every diagnostics-batch document active until results are collected, then evicts', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-diagnostics-batch-'));
    const first = join(root, 'batch-first.ts');
    const second = join(root, 'batch-second.ts');
    try {
      writeFileSync(first, 'export const first = 1;\n');
      writeFileSync(second, 'export const second = 2;\n');
      const sendRequest = jest.fn((_: string, params: unknown) => {
        const uri = (params as { textDocument: { uri: string } }).textDocument.uri;
        return Promise.resolve({
          kind: 'full',
          items: [
            {
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              message: uri,
            },
          ],
        });
      });
      const transport = {
        sendRequest,
        sendMessage: jest.fn(),
        sendNotification: jest.fn(),
        rejectAllPending: jest.fn(),
      };
      const manager = new DocumentManager(transport as never, 1);
      const state = server({ diagnosticProvider: true }, sendRequest);
      state.transport = transport as never;
      state.documentManager = manager;
      state.diagnosticsCache = new DiagnosticsCache();

      const results = await getDiagnosticsBatch(state, [first, second]);
      expect(results).toHaveLength(2);
      expect(results.every((result) => result.diagnostics.length === 1)).toBe(true);
      expect(manager.getOpenCount()).toBe(1);
      expect(manager.isOpen(first)).toBe(false);
      expect(manager.isOpen(second)).toBe(true);
      expect(transport.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
        textDocument: expect.objectContaining({ uri: expect.stringContaining('batch-first') }),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('sends rename only after prepareRename succeeds', async () => {
    const edit = {
      changes: {
        'file:///fixture.ts': [
          {
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 5 },
            },
            newText: 'renamed',
          },
        ],
      },
    };
    const sendRequest = jest
      .fn()
      .mockResolvedValueOnce({
        start: { line: 0, character: 13 },
        end: { line: 0, character: 18 },
      })
      .mockResolvedValueOnce(edit);
    const result = await renameSymbol(
      server({ renameProvider: { prepareProvider: true } }, sendRequest),
      TEST_FILE,
      { line: 0, character: 13 },
      'renamed'
    );
    expect(result).toEqual(edit);
    expect(sendRequest.mock.calls.map((call) => call[0])).toEqual([
      'textDocument/prepareRename',
      'textDocument/rename',
    ]);
  });
});
