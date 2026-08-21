import { describe, expect, it, jest } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LspToolOutcomeError } from './capabilities.js';
import { getDocumentSymbols, renameSymbol } from './operations.js';
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
