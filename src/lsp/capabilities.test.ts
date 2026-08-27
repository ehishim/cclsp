import { describe, expect, it } from 'bun:test';
import {
  LspToolOutcomeError,
  requireFileRenameSupport,
  requireMethodSupport,
  requirePrepareRenameSupport,
  supportsMethod,
} from './capabilities.js';
import type { ServerState } from './types.js';

function state(capabilities: Record<string, unknown>): ServerState {
  return {
    serverCapabilities: capabilities,
    config: { extensions: ['ts'], command: ['test-language-server', '--stdio'] },
  } as ServerState;
}

describe('server capability negotiation', () => {
  it('distinguishes provider objects and false or missing providers', () => {
    const server = state({
      documentSymbolProvider: {},
      typeDefinitionProvider: true,
      referencesProvider: false,
    });
    expect(supportsMethod(server, 'textDocument/documentSymbol')).toBe(true);
    expect(supportsMethod(server, 'textDocument/typeDefinition')).toBe(true);
    expect(supportsMethod(server, 'textDocument/references')).toBe(false);
    expect(supportsMethod(server, 'textDocument/hover')).toBe(false);
  });

  it('fails closed when capability state is absent', () => {
    const server = {
      config: { extensions: ['ts'], command: ['test-language-server', '--stdio'] },
    } as ServerState;
    expect(supportsMethod(server, 'textDocument/documentSymbol')).toBe(false);
    expect(() => requireMethodSupport(server, 'textDocument/documentSymbol')).toThrow(
      LspToolOutcomeError
    );
    expect(() => requirePrepareRenameSupport(server)).toThrow(LspToolOutcomeError);
  });

  it('returns a typed unsupported outcome naming method and server', () => {
    const server = state({});
    try {
      requireMethodSupport(server, 'textDocument/documentSymbol');
      throw new Error('expected capability guard to reject');
    } catch (error) {
      expect(error).toBeInstanceOf(LspToolOutcomeError);
      const typed = error as LspToolOutcomeError;
      expect(typed.outcome).toEqual({
        outcome: 'unsupported',
        code: 'LSP_METHOD_UNSUPPORTED',
        method: 'textDocument/documentSymbol',
        server: 'test-language-server --stdio',
      });
    }
  });

  it('requires rename prepareProvider instead of rename support alone', () => {
    expect(() => requirePrepareRenameSupport(state({ renameProvider: true }))).toThrow(
      LspToolOutcomeError
    );
    expect(() =>
      requirePrepareRenameSupport(state({ renameProvider: { prepareProvider: true } }))
    ).not.toThrow();
  });

  it('requires concrete non-empty file-operation filters', () => {
    for (const registration of [
      true,
      {},
      { filters: [] },
      { filters: [{}] },
      { filters: [{ scheme: 'file', pattern: {} }] },
    ]) {
      const server = state({
        workspace: { fileOperations: { willRename: registration } },
      });
      expect(() =>
        requireFileRenameSupport(server, 'workspace/willRenameFiles', '/repo/src/example.ts')
      ).toThrow(LspToolOutcomeError);
    }
  });

  it('matches file-operation registration filters', () => {
    const server = state({
      workspace: {
        fileOperations: {
          willRename: { filters: [{ scheme: 'file', pattern: { glob: '**/*.{ts,tsx}' } }] },
          didRename: { filters: [{ scheme: 'file', pattern: { glob: '**/*.{ts,tsx}' } }] },
        },
      },
    });
    expect(() =>
      requireFileRenameSupport(server, 'workspace/willRenameFiles', '/repo/src/example.ts')
    ).not.toThrow();
    expect(() =>
      requireFileRenameSupport(server, 'workspace/willRenameFiles', '/repo/src/example.py')
    ).toThrow(LspToolOutcomeError);
  });
});
