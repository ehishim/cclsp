import { describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LSPClient } from './lsp-client.js';
import { LspToolOutcomeError } from './lsp/capabilities.js';
import { getDiagnosticsTool } from './tools/diagnostics.js';
import { getCodeActionsTool, getCompletionsTool } from './tools/language-features.js';
import { findReferencesTool } from './tools/navigation.js';
import { renameFileTool } from './tools/refactoring.js';
import { type ToolDefinition, boundToolResult, registerTools } from './tools/registry.js';
import { findWorkspaceSymbolsTool, getDocumentSymbolsTool } from './tools/symbols.js';
import { pathToUri } from './utils.js';

function asClient(value: Record<string, unknown>): LSPClient {
  return value as unknown as LSPClient;
}

describe('capability tool contracts', () => {
  it('returns compact flattened document symbols with ranges, totals, and readable text', async () => {
    const client = asClient({
      getDocumentSymbolsWithProvider: jest.fn().mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [
          {
            name: 'Example',
            kind: 5,
            range: { start: { line: 0, character: 0 }, end: { line: 4, character: 1 } },
            selectionRange: {
              start: { line: 0, character: 13 },
              end: { line: 0, character: 20 },
            },
            children: [
              {
                name: 'run',
                kind: 6,
                range: { start: { line: 1, character: 2 }, end: { line: 3, character: 3 } },
                selectionRange: {
                  start: { line: 1, character: 2 },
                  end: { line: 1, character: 5 },
                },
              },
            ],
          },
        ],
      }),
      symbolKindToString: (kind: number) => ({ 5: 'class', 6: 'method' })[kind] ?? 'unknown',
    });
    const result = await getDocumentSymbolsTool.handler({ file_path: 'example.ts' }, client);
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      shown: 2,
      total: 2,
      omitted: 0,
      recovery: null,
      symbols: [
        {
          name: 'Example',
          kind: 'class',
          range: { start: { line: 0, character: 0 } },
          selectionRange: { start: { line: 0, character: 13 } },
          children: [],
        },
        { name: 'run', kind: 'method', container: 'Example', children: [] },
      ],
    });
    expect(result.content[0]?.text).toContain('Document symbols (2/2)');
    expect(result.content[0]?.text).toContain('L1:C1-L5:C2 · class · Example');
    expect(result.content[0]?.text).not.toContain('{\n');
  });

  it('bounds document-symbol rows and exposes raw hierarchy only when requested', async () => {
    const value = ['alpha', 'beta', 'gamma'].map((name, index) => ({
      name,
      kind: 13,
      range: { start: { line: index, character: 0 }, end: { line: index, character: name.length } },
      selectionRange: { start: { line: index, character: 0 }, end: { line: index, character: name.length } },
      children: [],
    }));
    const client = asClient({
      getDocumentSymbolsWithProvider: jest.fn().mockResolvedValue({ outcome: 'ok', provider: 'lsp', value }),
      symbolKindToString: () => 'variable',
    });
    const bounded = await getDocumentSymbolsTool.handler({ file_path: 'example.ts', max_results: 2 }, client);
    expect(bounded.structuredContent).toMatchObject({ shown: 2, total: 3, omitted: 1 });
    expect((bounded.structuredContent as any).rawSymbols).toBeUndefined();

    const spooled = (bounded.structuredContent as any).resultFile as string;
    expect(typeof spooled).toBe('string');
    expect(bounded.content[0]?.text).toContain(spooled);
    const complete = JSON.parse(readFileSync(spooled, 'utf8'));
    expect(complete.symbols.map((row: { name: string }) => row.name)).toEqual(['alpha', 'beta', 'gamma']);

    const diagnostic = await getDocumentSymbolsTool.handler({ file_path: 'example.ts', max_results: 1, include_raw: true }, client);
    expect((diagnostic.structuredContent as any).rawSymbols).toHaveLength(1);
  });

  it('returns every declaration when no explicit narrowing is requested', async () => {
    const value = Array.from({ length: 300 }, (_, index) => ({
      name: `symbol${index}`,
      kind: 13,
      range: { start: { line: index, character: 0 }, end: { line: index, character: 4 } },
      selectionRange: { start: { line: index, character: 0 }, end: { line: index, character: 4 } },
      children: [],
    }));
    const result = await getDocumentSymbolsTool.handler({ file_path: 'example.ts' }, asClient({
      getDocumentSymbolsWithProvider: jest.fn().mockResolvedValue({ outcome: 'ok', provider: 'lsp', value }),
      symbolKindToString: () => 'variable',
    }));
    expect(result.structuredContent).toMatchObject({ shown: 300, total: 300, omitted: 0 });
    expect((result.structuredContent as any).resultFile).toBeUndefined();
  });

  it('reports an empty outcome for a file with no declarations', async () => {
    const result = await getDocumentSymbolsTool.handler({ file_path: 'empty.ts' }, asClient({
      getDocumentSymbolsWithProvider: jest.fn().mockResolvedValue({ outcome: 'ok', provider: 'lsp', value: [] }),
      symbolKindToString: () => 'variable',
    }));
    expect(result.structuredContent).toMatchObject({
      outcome: 'empty', provider: 'lsp', shown: 0, total: 0, omitted: 0,
    });
  });

  it('returns typed reference locations for Hub range normalization', async () => {
    const locations = [
      { uri: 'file:///workspace/src/a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } } },
      { uri: 'file:///workspace/src/b.ts', range: { start: { line: 8, character: 2 }, end: { line: 8, character: 7 } } },
    ];
    const client = asClient({
      findSymbolsByName: jest.fn().mockResolvedValue({
        matches: [{ name: 'answer', kind: 12, position: { line: 0, character: 0 } }],
      }),
      findReferences: jest.fn().mockResolvedValue(locations),
      symbolKindToString: () => 'function',
    });
    const result = await findReferencesTool.handler({
      file_path: '/workspace/src/a.ts', symbol_name: 'answer', include_declaration: true,
    }, client);
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok', provider: 'lsp', locations, shown: 2, total: 2, omitted: 0,
    });
    expect(result.content[0]?.text).toContain('/workspace/src/b.ts:9:3');
  });

  it('bounds workspace symbols with canonical totals and recovery', async () => {
    const symbols = ['alpha', 'beta', 'gamma'].map((name, index) => ({
      name, kind: 13,
      location: {
        uri: `file:///workspace/src/${name}.ts`,
        range: { start: { line: index, character: 0 }, end: { line: index, character: name.length } },
      },
    }));
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'a', max_results: 2 },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: true }),
        symbolKindToString: () => 'variable',
      }),
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok', provider: 'lsp', shown: 2, total: 3, omitted: 1,
    });
    const spooled = (result.structuredContent as any).resultFile as string;
    expect(result.content[0]?.text).toContain(spooled);
    expect(JSON.parse(readFileSync(spooled, 'utf8')).symbols).toHaveLength(3);
  });

  it('reports zero rows as a SCOPED empty only when the provider is confirmed answering', async () => {
    // `empty` is an assertion that the workspace has no such symbol. It is the
    // answer that makes a caller stop looking, so it needs the stronger evidence.
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'nothing' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols: [], readinessConfirmed: true }),
        symbolKindToString: () => 'variable',
      }),
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'empty', shown: 0, total: 0 });
    // Zero rows must never read as proof of absence: this searches loaded files,
    // so the caller is routed to the tool that searches the repository.
    expect((result.structuredContent as any).recovery).toContain('ast_search');
    expect(result.content[0]?.text).toContain('LOADED files only');
  });

  it('reports zero rows as STALE while the provider is not confirmed answering', async () => {
    // The measured defect: an unindexed navto answers [] and it was typed as
    // a negative, so an existing symbol read as "no match" with exit 0.
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'deriveUnifiedAgentState' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols: [], readinessConfirmed: false }),
        symbolKindToString: () => 'variable',
      }),
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'stale', shown: 0 });
    expect((result.structuredContent as any).recovery).toContain('ast_search');
  });

  it('keeps rows found while unconfirmed, but does not call the answer complete', async () => {
    const symbols = [{
      name: 'found', kind: 13,
      location: { uri: 'file:///workspace/src/found.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } } },
    }];
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'found' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: false }),
        symbolKindToString: () => 'variable',
      }),
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'ok', shown: 1 });
    expect((result.structuredContent as any).readinessConfirmed).toBe(false);
  });

  it('returns typed diagnostics including the source file for range normalization', async () => {
    const diagnostic = {
      severity: 1, message: 'broken',
      range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
    };
    const result = await getDiagnosticsTool.handler(
      { file_path: '/workspace/src/a.ts' },
      asClient({ getDiagnostics: jest.fn().mockResolvedValue([diagnostic]) }),
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok', provider: 'lsp', file: '/workspace/src/a.ts',
      diagnostics: [diagnostic], shown: 1, total: 1, omitted: 0,
    });
  });

  it('bounds completion output while preserving server incompleteness', async () => {
    const client = asClient({
      getCompletions: jest.fn().mockResolvedValue({
        items: [{ label: 'alpha' }, { label: 'beta' }],
        isIncomplete: true,
      }),
    });
    const result = await getCompletionsTool.handler(
      { file_path: 'example.ts', line: 1, character: 1, limit: 1 },
      client
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      items: [{ label: 'alpha' }],
      isIncomplete: true,
      truncated: true,
      resolvedCount: 0,
    });
  });

  it('orders completions deterministically and resolves only the bounded displayed head', async () => {
    const resolveCompletionItem = jest.fn((_: string, item: { label: string }) =>
      Promise.resolve({ ...item, documentation: `Docs for ${item.label}` })
    );
    const client = asClient({
      getCompletions: jest.fn().mockResolvedValue({
        items: [
          { label: 'zeta', sortText: '2' },
          { label: 'beta', sortText: '1' },
          { label: 'alpha', sortText: '1' },
        ],
        isIncomplete: false,
        syntheticTrigger: false,
      }),
      supportsCompletionResolve: jest.fn().mockResolvedValue(true),
      resolveCompletionItem,
    });
    const result = await getCompletionsTool.handler(
      {
        file_path: 'example.ts',
        line: 1,
        character: 1,
        limit: 2,
        resolve_limit: 20,
      },
      client
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      items: [
        { label: 'alpha', documentation: 'Docs for alpha' },
        { label: 'beta', documentation: 'Docs for beta' },
      ],
      resolvedCount: 2,
      truncated: true,
    });
    expect(resolveCompletionItem.mock.calls.map((call) => call[1].label)).toEqual([
      'alpha',
      'beta',
    ]);
  });

  it('caps completion resolve fan-out at twenty items', async () => {
    const resolveCompletionItem = jest.fn((_: string, item: unknown) => Promise.resolve(item));
    const client = asClient({
      getCompletions: jest.fn().mockResolvedValue({
        items: Array.from({ length: 25 }, (_, index) => ({
          label: `item-${String(index).padStart(2, '0')}`,
        })),
        isIncomplete: false,
        syntheticTrigger: false,
      }),
      supportsCompletionResolve: jest.fn().mockResolvedValue(true),
      resolveCompletionItem,
    });
    const result = await getCompletionsTool.handler(
      {
        file_path: 'example.ts',
        line: 1,
        character: 1,
        limit: 25,
        resolve_limit: 100,
      },
      client
    );
    expect(result.structuredContent).toMatchObject({ resolvedCount: 20 });
    expect(resolveCompletionItem).toHaveBeenCalledTimes(20);
  });

  it('ranks actions and bounds concrete edit previews', async () => {
    const edits = Array.from({ length: 7 }, (_, index) => ({
      range: {
        start: { line: index, character: 0 },
        end: { line: index, character: 1 },
      },
      newText: `replacement-${index}`,
    }));
    const client = asClient({
      getCodeActions: jest.fn().mockResolvedValue([
        { title: 'Source', kind: 'source.organizeImports' },
        { title: 'Refactor', kind: 'refactor.extract' },
        { title: 'Quick fix', kind: 'quickfix', edit: { changes: { 'file:///a.ts': edits } } },
        { title: 'Preferred other', kind: 'custom', isPreferred: true },
      ]),
    });
    const result = await getCodeActionsTool.handler(
      {
        file_path: 'example.ts',
        start_line: 1,
        start_character: 1,
        end_line: 1,
        end_character: 1,
      },
      client
    );
    const actions = (result.structuredContent as { actions: Array<Record<string, unknown>> })
      .actions;
    expect(actions.map((action) => action.title)).toEqual([
      'Preferred other',
      'Quick fix',
      'Refactor',
      'Source',
    ]);
    expect(actions[1]?.preview).toHaveLength(6);
    expect(actions[1]?.preview).toEqual([
      ...edits.slice(0, 5).map((edit) => ({
        uri: 'file:///a.ts',
        range: edit.range,
        newText: edit.newText,
      })),
      { omittedEdits: 2 },
    ]);
  });

  it('rejects a partial code-action end range before document-symbol or action requests', async () => {
    const getDocumentSymbols = jest.fn();
    const getCodeActions = jest.fn();
    const result = await getCodeActionsTool.handler(
      { file_path: 'example.ts', query: 'run', end_line: 2 },
      asClient({ getDocumentSymbols, getCodeActions })
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'LSP_POSITION_INVALID' },
    });
    expect(getDocumentSymbols).not.toHaveBeenCalled();
    expect(getCodeActions).not.toHaveBeenCalled();
  });

  it('previews and applies only a selected code action WorkspaceEdit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-code-action-'));
    const file = join(root, 'example.ts');
    writeFileSync(file, 'const value = 1;\n');
    const edit = {
      changes: {
        [pathToUri(file)]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            newText: 'renamed',
          },
        ],
      },
    };
    const client = asClient({
      getCodeActions: jest.fn().mockResolvedValue([
        { title: 'Rename local', edit },
        { title: 'Run command', command: { title: 'Run', command: 'fixture.run' } },
      ]),
      resolveCodeAction: jest.fn((_: string, action: unknown) => Promise.resolve(action)),
      syncFileContent: jest.fn().mockResolvedValue(undefined),
    });
    try {
      const preview = await getCodeActionsTool.handler(
        {
          file_path: file,
          start_line: 1,
          start_character: 1,
          end_line: 1,
          end_character: 16,
          title: 'Rename local',
        },
        client
      );
      expect(preview.structuredContent).toMatchObject({ applied: false, title: 'Rename local' });
      expect(readFileSync(file, 'utf8')).toBe('const value = 1;\n');

      const applied = await getCodeActionsTool.handler(
        {
          file_path: file,
          start_line: 1,
          start_character: 1,
          end_line: 1,
          end_character: 16,
          title: 'Rename local',
          apply: true,
        },
        client
      );
      expect(applied.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
      expect(readFileSync(file, 'utf8')).toBe('const renamed = 1;\n');

      const commandOnly = await getCodeActionsTool.handler(
        {
          file_path: file,
          start_line: 1,
          start_character: 1,
          end_line: 1,
          end_character: 18,
          title: 'Run command',
          apply: true,
        },
        client
      );
      expect(commandOnly).toMatchObject({
        isError: true,
        structuredContent: { code: 'LSP_ACTION_NOT_APPLICABLE' },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies TextDocumentEdit documentChanges and rejects resource operations', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-document-changes-'));
    const file = join(root, 'example.ts');
    writeFileSync(file, 'const value = 1;\n');
    const getCodeActions = jest.fn().mockResolvedValue([
      {
        title: 'Text document change',
        edit: {
          documentChanges: [
            {
              textDocument: { uri: pathToUri(file), version: null },
              edits: [
                {
                  range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
                  newText: 'renamed',
                },
              ],
            },
          ],
        },
      },
      {
        title: 'Resource change',
        edit: {
          documentChanges: [{ kind: 'rename', oldUri: pathToUri(file), newUri: pathToUri(file) }],
        },
      },
    ]);
    const client = asClient({
      getCodeActions,
      resolveCodeAction: jest.fn((_: string, action: unknown) => Promise.resolve(action)),
      syncFileContent: jest.fn().mockResolvedValue(undefined),
    });
    const baseArgs = {
      file_path: file,
      start_line: 1,
      start_character: 1,
      end_line: 1,
      end_character: 16,
      apply: true,
    };
    try {
      const applied = await getCodeActionsTool.handler(
        { ...baseArgs, title: 'Text document change' },
        client
      );
      expect(applied.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
      expect(readFileSync(file, 'utf8')).toBe('const renamed = 1;\n');

      const rejected = await getCodeActionsTool.handler(
        { ...baseArgs, title: 'Resource change' },
        client
      );
      expect(rejected).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'LSP_ACTION_NOT_APPLICABLE',
          reason: expect.stringContaining('unsupported resource operation "rename"'),
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps file rename dry-run side-effect free and applies imports before didRenameFiles', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-file-rename-'));
    const oldPath = join(root, 'old.ts');
    const newPath = join(root, 'new.ts');
    const consumer = join(root, 'consumer.ts');
    writeFileSync(oldPath, 'export const value = 1;\n');
    writeFileSync(consumer, "import { value } from './old';\n");
    const didRenameFiles = jest.fn().mockResolvedValue(undefined);
    const client = asClient({
      willRenameFiles: jest.fn().mockResolvedValue({
        changes: {
          [pathToUri(consumer)]: [
            {
              range: { start: { line: 0, character: 23 }, end: { line: 0, character: 28 } },
              newText: './new',
            },
          ],
        },
      }),
      didRenameFiles,
      syncFileContent: jest.fn().mockResolvedValue(undefined),
    });
    try {
      const preview = await renameFileTool.handler(
        { old_path: oldPath, new_path: newPath },
        client
      );
      expect(preview.structuredContent).toMatchObject({ outcome: 'ok', applied: false });
      expect(readFileSync(oldPath, 'utf8')).toContain('value');
      expect(() => readFileSync(newPath, 'utf8')).toThrow();
      expect(didRenameFiles).not.toHaveBeenCalled();

      const applied = await renameFileTool.handler(
        { old_path: oldPath, new_path: newPath, dry_run: false },
        client
      );
      expect(applied.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
      expect(readFileSync(newPath, 'utf8')).toContain('value');
      expect(readFileSync(consumer, 'utf8')).toBe("import { value } from './new';\n");
      expect(didRenameFiles).toHaveBeenCalledWith(oldPath, newPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes typed unsupported errors as non-success MCP outcomes', async () => {
    const handlers: Array<(request: any) => Promise<any>> = [];
    const server = {
      setRequestHandler: (_schema: unknown, handler: (request: any) => Promise<any>) => {
        handlers.push(handler);
      },
    };
    const tool: ToolDefinition = {
      name: 'unsupported_fixture',
      description: 'fixture',
      inputSchema: { type: 'object' },
      handler: async () => {
        throw new LspToolOutcomeError({
          outcome: 'unsupported',
          code: 'LSP_METHOD_UNSUPPORTED',
          method: 'textDocument/documentSymbol',
          server: 'fixture-ls',
        });
      },
    };
    registerTools(server as never, [tool], asClient({}));
    const callHandler = handlers[1];
    if (!callHandler) throw new Error('call handler was not registered');
    const result = await callHandler({
      params: { name: 'unsupported_fixture', arguments: {} },
    });
    expect(result).toMatchObject({
      isError: true,
      structuredContent: {
        outcome: 'unsupported',
        code: 'LSP_METHOD_UNSUPPORTED',
        method: 'textDocument/documentSymbol',
        server: 'fixture-ls',
      },
    });
  });

  it('spools an oversized result and points at it instead of refusing the answer', () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => ({ name: `symbol${index}`, detail: 'x'.repeat(200) }));
    const bounded = boundToolResult({
      content: [{ type: 'text', text: `head line\n${'row\n'.repeat(5_000)}` }],
      structuredContent: { outcome: 'ok', provider: 'lsp', shown: 2_000, total: 2_000, omitted: 0, symbols: rows },
    }, 4_096);
    expect(bounded.isError).toBeUndefined();
    expect(bounded.structuredContent).toMatchObject({ outcome: 'ok', provider: 'lsp', bounded: true, total: 2_000 });
    const spooled = (bounded.structuredContent as any).resultFile as string;
    expect(bounded.content[0]?.text.startsWith('head line')).toBe(true);
    expect(bounded.content[0]?.text).toContain(spooled);
    const complete = JSON.parse(readFileSync(spooled, 'utf8'));
    expect(complete.structuredContent.symbols).toHaveLength(2_000);
  });
});
