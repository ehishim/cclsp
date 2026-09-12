import { describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LSPClient } from './lsp-client.js';
import { LspToolOutcomeError } from './lsp/capabilities.js';
import { astSearchTool } from './tools/ast-search.js';
import {
  getIncomingCallsTool,
  getOutgoingCallsTool,
  prepareCallHierarchyTool,
} from './tools/call-hierarchy.js';
import { getDiagnosticsTool } from './tools/diagnostics.js';
import { getHoverTool } from './tools/hover.js';
import {
  createGetCodeActionsTool,
  getCodeActionsTool,
  getCompletionsTool,
  getSignatureHelpTool,
} from './tools/language-features.js';
import {
  findDefinitionTool,
  findImplementationTool,
  findReferencesTool,
} from './tools/navigation.js';
import { renameFileTool } from './tools/refactoring.js';
import { type ToolDefinition, boundToolResult, registerTools } from './tools/registry.js';
import { findWorkspaceSymbolsTool, getDocumentSymbolsTool } from './tools/symbols.js';
import { pathToUri } from './utils.js';

function asClient(value: Record<string, unknown>): LSPClient {
  return {
    withDocumentWriteScopes: (_paths: string[], action: () => Promise<unknown>) => action(),
    synchronizeRewriteFilesStrict: async () => undefined,
    invalidateSourceFiles: async () => undefined,
    didRenameFilesBatch: async (moves: Array<{ oldPath: string; newPath: string }>) => {
      const didRenameFiles = value.didRenameFiles as
        | ((oldPath: string, newPath: string) => Promise<void>)
        | undefined;
      for (const move of moves) await didRenameFiles?.(move.oldPath, move.newPath);
    },
    ...value,
  } as unknown as LSPClient;
}

describe('capability tool contracts', () => {
  it('spools the complete hover batch without dropping long signatures', async () => {
    const contents = `type Huge = ${'x'.repeat(150000)}END`;
    const client = asClient({ hoverBatch: async () => [{ contents }] });
    const result = await getHoverTool.handler(
      { file_path: 'a.ts', positions: [{ line: 1, character: 1 }] },
      client
    );
    const path = result.structuredContent?.resultFile as string;
    try {
      const body = JSON.parse(readFileSync(path, 'utf8'));
      expect(body.hovers).toEqual([{ contents }]);
      expect(body.positions).toEqual([{ line: 1, character: 1 }]);
      expect(result.structuredContent).toMatchObject({ total: 1, shown: 0, omitted: 1 });
      expect(JSON.stringify(result.content).length).toBeLessThan(1024);
    } finally {
      if (path) rmSync(path, { force: true });
    }
  });
  it('routes ordered hover positions through one batch and rejects mixed selectors', async () => {
    const batch = jest.fn().mockResolvedValue([{ contents: 'first' }, null]);
    const client = asClient({ hoverBatch: batch });
    const result = await getHoverTool.handler(
      {
        file_path: 'a.ts',
        positions: [
          { line: 2, character: 3 },
          { line: 4, character: 5 },
        ],
      },
      client
    );
    expect(batch).toHaveBeenCalledTimes(1);
    expect(batch.mock.calls[0]?.[1]).toEqual([
      { line: 1, character: 2 },
      { line: 3, character: 4 },
    ]);
    expect(result.structuredContent).toMatchObject({
      hovers: [{ contents: 'first' }, null],
      total: 2,
      omitted: 0,
    });
    const bad = await getHoverTool.handler(
      { file_path: 'a.ts', line: 1, character: 1, positions: [{ line: 2, character: 3 }] },
      client
    );
    expect(bad.isError).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
  });
  it('answers several hover names under one freshness batch', async () => {
    const hoverBatch = jest.fn(async (_file: string, positions: Array<{ line: number }>) =>
      positions.map((position) => ({ contents: `hover-${position.line}` }))
    );
    const client = asClient({
      getDocumentSymbolsWithProvider: async () => ({
        outcome: 'ok' as const,
        provider: 'lsp' as const,
        value: [
          {
            name: 'alpha',
            kind: 12,
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
            selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
          {
            name: 'beta',
            kind: 12,
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
            selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
          },
        ],
      }),
      hoverBatch,
      symbolKindToString: () => 'function',
    });

    const result = await getHoverTool.handler(
      { file_path: '/workspace/src/a.ts', query: ['alpha', 'beta'] },
      client
    );

    expect(hoverBatch).toHaveBeenCalledTimes(1);
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      shown: 2,
      total: 2,
      omitted: 0,
      queries: ['alpha', 'beta'],
      perQuery: [
        { query: 'alpha', shown: 1, total: 1, outcome: 'ok' },
        { query: 'beta', shown: 1, total: 1, outcome: 'ok' },
      ],
    });
    const limited = await getHoverTool.handler(
      { file_path: '/workspace/src/a.ts', query: ['alpha', 'beta'], max_results: 1 },
      client
    );
    const resultFile = limited.structuredContent?.resultFile as string;
    try {
      expect(limited.structuredContent).toMatchObject({ shown: 1, total: 2, omitted: 1 });
      expect(JSON.parse(readFileSync(resultFile, 'utf8')).perQuery).toHaveLength(2);
    } finally {
      if (resultFile) rmSync(resultFile, { force: true });
    }
  });

  it('applies signature max_results to the single-name form too', async () => {
    const result = await getSignatureHelpTool.handler(
      { file_path: '/workspace/src/a.ts', line: 1, character: 1, max_results: 1 },
      asClient({
        getSignatureHelp: async () => ({
          signatures: [{ label: 'first' }, { label: 'second' }],
          activeSignature: 1,
        }),
      })
    );
    expect(result.structuredContent).toMatchObject({
      signatures: [{ label: 'first' }],
      activeSignature: null,
      shown: 1,
      total: 2,
      omitted: 1,
    });
    const resultFile = result.structuredContent?.resultFile as string;
    try {
      expect(JSON.parse(readFileSync(resultFile, 'utf8')).signatures).toHaveLength(2);
    } finally {
      if (resultFile) rmSync(resultFile, { force: true });
    }
  });

  it('uses one attributed batch pattern for implementation, signature and call hierarchy', async () => {
    const file = '/workspace/src/a.ts';
    const getDocumentSymbolsWithProvider = async () => ({
      outcome: 'ok' as const,
      provider: 'lsp' as const,
      value: [
        {
          name: 'alpha',
          kind: 12,
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          selectionRange: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
        {
          name: 'beta',
          kind: 12,
          range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
          selectionRange: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
        },
      ],
    });
    const item = (line: number, name: string) => ({
      name,
      kind: 12,
      uri: pathToUri(file),
      range: { start: { line, character: 0 }, end: { line, character: 5 } },
      selectionRange: { start: { line, character: 0 }, end: { line, character: 5 } },
    });
    const client = asClient({
      getDocumentSymbolsWithProvider,
      findImplementation: async (_file: string, position: { line: number }) => [
        {
          uri: pathToUri(file),
          range: { start: position, end: { ...position, character: 5 } },
        },
      ],
      getSignatureHelp: async (_file: string, position: { line: number }) => ({
        signatures: [{ label: `signature-${position.line}` }],
      }),
      prepareCallHierarchy: async (_file: string, position: { line: number }) => [
        item(position.line, position.line === 0 ? 'alpha' : 'beta'),
      ],
      incomingCalls: async (target: { name: string }) => [
        { from: item(target.name === 'alpha' ? 2 : 3, `from-${target.name}`), fromRanges: [] },
      ],
      outgoingCalls: async (target: { name: string }) => [
        { to: item(target.name === 'alpha' ? 4 : 5, `to-${target.name}`), fromRanges: [] },
      ],
      symbolKindToString: () => 'function',
    });

    const implementation = await findImplementationTool.handler(
      { file_path: file, query: ['alpha', 'beta'] },
      client
    );
    expect(implementation.structuredContent).toMatchObject({
      shown: 2,
      total: 2,
      perQuery: [
        { query: 'alpha', total: 1 },
        { query: 'beta', total: 1 },
      ],
    });

    const signature = await getSignatureHelpTool.handler(
      { file_path: file, query: ['alpha', 'beta'], max_results: 1 },
      client
    );
    expect(signature.structuredContent).toMatchObject({
      shown: 1,
      total: 2,
      omitted: 1,
      perQuery: [
        { query: 'alpha', total: 1 },
        { query: 'beta', total: 1 },
      ],
    });
    const signatureFile = signature.structuredContent?.resultFile as string;
    try {
      expect(JSON.parse(readFileSync(signatureFile, 'utf8')).perQuery).toHaveLength(2);
    } finally {
      if (signatureFile) rmSync(signatureFile, { force: true });
    }

    const prepared = await prepareCallHierarchyTool.handler(
      { file_path: file, query: ['alpha', 'beta'], max_results: 1, preview: false },
      client
    );
    expect(prepared.structuredContent).toMatchObject({
      shown: 1,
      total: 2,
      omitted: 1,
      perQuery: [
        { query: 'alpha', total: 1 },
        { query: 'beta', total: 1 },
      ],
    });
    const preparedFile = prepared.structuredContent?.resultFile as string;
    try {
      expect(JSON.parse(readFileSync(preparedFile, 'utf8')).perQuery).toHaveLength(2);
    } finally {
      if (preparedFile) rmSync(preparedFile, { force: true });
    }

    for (const [tool, label] of [
      [getIncomingCallsTool, 'from'],
      [getOutgoingCallsTool, 'to'],
    ] as const) {
      const calls = await tool.handler(
        { file_path: file, query: ['alpha', 'beta'], preview: false },
        client
      );
      expect(calls.structuredContent).toMatchObject({
        shown: 2,
        total: 2,
        perQuery: [
          { query: 'alpha', total: 1 },
          { query: 'beta', total: 1 },
        ],
      });
      expect(calls.content[0]?.text).toContain(`${label}-alpha`);
      expect(calls.content[0]?.text).toContain(`${label}-beta`);
    }

    // If the first name spends the shared limit and the second has exactly one
    // row, that omitted row still exists in the one aggregate spool.
    const limited = await getOutgoingCallsTool.handler(
      { file_path: file, query: ['alpha', 'beta'], max_results: 1, preview: false },
      client
    );
    expect(limited.structuredContent).toMatchObject({ shown: 1, total: 2, omitted: 1 });
    const resultFile = limited.structuredContent?.resultFile as string;
    try {
      const complete = JSON.parse(readFileSync(resultFile, 'utf8'));
      expect(complete.perQuery).toMatchObject([
        { query: 'alpha', total: 1, calls: [{ to: { name: 'to-alpha' } }] },
        { query: 'beta', total: 1, calls: [{ to: { name: 'to-beta' } }] },
      ]);
    } finally {
      if (resultFile) rmSync(resultFile, { force: true });
    }
  });

  it('refuses a name list mixed with position before any provider request', async () => {
    const getDocumentSymbolsWithProvider = jest.fn();
    const client = asClient({ getDocumentSymbolsWithProvider });
    for (const tool of [
      findImplementationTool,
      getHoverTool,
      getSignatureHelpTool,
      prepareCallHierarchyTool,
      getIncomingCallsTool,
      getOutgoingCallsTool,
    ]) {
      const result = await tool.handler(
        { file_path: '/workspace/src/a.ts', query: ['alpha', 'beta'], line: 1, character: 1 },
        client
      );
      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain('provide query or line/character, not both');
    }
    expect(getDocumentSymbolsWithProvider).not.toHaveBeenCalled();
  });

  it('keeps every declaration beyond the old document-symbol ceiling in a complete spool', async () => {
    const value = Array.from({ length: 5001 }, (_, i) => ({
      name: `Symbol${i}`,
      kind: 12,
      range: { start: { line: i, character: 0 }, end: { line: i, character: 8 } },
      selectionRange: { start: { line: i, character: 0 }, end: { line: i, character: 8 } },
      children: [],
    }));
    const client = asClient({
      getDocumentSymbolsWithProvider: async () => ({ outcome: 'ok', provider: 'lsp', value }),
      symbolKindToString: () => 'function',
    });
    const result = await getDocumentSymbolsTool.handler({ file_path: 'many.ts' }, client);
    const path = result.structuredContent?.resultFile as string;
    try {
      const complete = JSON.parse(readFileSync(path, 'utf8'));
      expect(complete.symbols.length).toBe(5001);
      expect(complete.symbols.at(-1).name).toBe('Symbol5000');
      expect(result.structuredContent).toMatchObject({ total: 5001, omitted: 5001, shown: 0 });
    } finally {
      if (path) rmSync(path, { force: true });
    }
  });
  it('restores import edits when the file move fails after edits were written', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-rename-rollback-'));
    const oldPath = join(root, 'owner.ts');
    const importer = join(root, 'consumer.ts');
    writeFileSync(oldPath, 'export const value = 1;');
    const original = 'import { value } from "./owner";';
    writeFileSync(importer, original);
    const edit = {
      changes: {
        [pathToUri(importer)]: [
          {
            range: { start: { line: 0, character: 23 }, end: { line: 0, character: 30 } },
            newText: './next',
          },
        ],
      },
    };
    const client = asClient({
      willRenameFiles: async () => edit,
      syncFileContent: async () => undefined,
      didRenameFiles: async () => undefined,
    });
    try {
      const newPath = join(root, 'missing', 'next.ts');
      const preview = await renameFileTool.handler(
        { old_path: oldPath, new_path: newPath },
        client
      );
      const result = await renameFileTool.handler(
        {
          old_path: oldPath,
          new_path: newPath,
          dry_run: false,
          candidate_id: preview.structuredContent?.candidateId,
        },
        client
      );
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toMatchObject({
        outcome: 'rejected',
        code: 'LSP_FILE_RENAME_APPLY_FAILED',
        rollbackFailures: [],
      });
      expect(readFileSync(importer, 'utf8')).toBe(original);
      expect(readFileSync(oldPath, 'utf8')).toBe('export const value = 1;');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
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
      selectionRange: {
        start: { line: index, character: 0 },
        end: { line: index, character: name.length },
      },
      children: [],
    }));
    const client = asClient({
      getDocumentSymbolsWithProvider: jest
        .fn()
        .mockResolvedValue({ outcome: 'ok', provider: 'lsp', value }),
      symbolKindToString: () => 'variable',
    });
    const bounded = await getDocumentSymbolsTool.handler(
      { file_path: 'example.ts', max_results: 2 },
      client
    );
    expect(bounded.structuredContent).toMatchObject({ shown: 2, total: 3, omitted: 1 });
    expect((bounded.structuredContent as any).rawSymbols).toBeUndefined();

    const spooled = (bounded.structuredContent as any).resultFile as string;
    expect(typeof spooled).toBe('string');
    expect(bounded.content[0]?.text).toContain(spooled);
    const complete = JSON.parse(readFileSync(spooled, 'utf8'));
    expect(complete.symbols.map((row: { name: string }) => row.name)).toEqual([
      'alpha',
      'beta',
      'gamma',
    ]);

    const diagnostic = await getDocumentSymbolsTool.handler(
      { file_path: 'example.ts', max_results: 1, include_raw: true },
      client
    );
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
    const result = await getDocumentSymbolsTool.handler(
      { file_path: 'example.ts' },
      asClient({
        getDocumentSymbolsWithProvider: jest
          .fn()
          .mockResolvedValue({ outcome: 'ok', provider: 'lsp', value }),
        symbolKindToString: () => 'variable',
      })
    );
    expect(result.structuredContent).toMatchObject({ shown: 300, total: 300, omitted: 0 });
    expect((result.structuredContent as any).resultFile).toBeUndefined();
  });

  it('reports an empty outcome for a file with no declarations', async () => {
    const result = await getDocumentSymbolsTool.handler(
      { file_path: 'empty.ts' },
      asClient({
        getDocumentSymbolsWithProvider: jest
          .fn()
          .mockResolvedValue({ outcome: 'ok', provider: 'lsp', value: [] }),
        symbolKindToString: () => 'variable',
      })
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'empty',
      provider: 'lsp',
      shown: 0,
      total: 0,
      omitted: 0,
    });
  });

  it('returns typed reference locations for Hub range normalization', async () => {
    const locations = [
      {
        uri: 'file:///workspace/src/a.ts',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
      },
      {
        uri: 'file:///workspace/src/b.ts',
        range: { start: { line: 8, character: 2 }, end: { line: 8, character: 7 } },
      },
    ];
    const client = asClient({
      findSymbolsByName: jest.fn().mockResolvedValue({
        matches: [{ name: 'answer', kind: 12, position: { line: 0, character: 0 } }],
      }),
      findReferences: jest.fn().mockResolvedValue(locations),
      symbolKindToString: () => 'function',
    });
    const result = await findReferencesTool.handler(
      {
        file_path: '/workspace/src/a.ts',
        symbol_name: 'answer',
        include_declaration: true,
      },
      client
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      provider: 'lsp',
      locations,
      shown: 2,
      total: 2,
      omitted: 0,
    });
    expect(result.content[0]?.text).toContain('/workspace/src/b.ts:9:3');
  });

  it('answers several reference names in one request, each count attributable', async () => {
    // Mapping an unfamiliar area means asking about three or four symbols at once.
    // One call per name costs a whole turn each, and a merged answer could not say
    // which name found nothing.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-multiref-'));
    const file = join(dir, 'multi.ts');
    writeFileSync(file, 'export const alpha = 1;\nexport const beta = alpha;\n');
    try {
      const asked: string[] = [];
      const client = asClient({
        findSymbolsByName: jest.fn(async (_file: string, name: string) => {
          asked.push(name);
          return name === 'missing'
            ? { matches: [] }
            : { matches: [{ name, kind: 13, position: { line: 0, character: 13 } }] };
        }),
        findReferences: jest.fn(async () => [
          {
            uri: pathToUri(file),
            range: { start: { line: 1, character: 17 }, end: { line: 1, character: 22 } },
          },
        ]),
        symbolKindToString: () => 'variable',
      });

      const result = await findReferencesTool.handler(
        { file_path: file, symbol_name: ['alpha', 'missing'] },
        client
      );

      expect(asked).toEqual(['alpha', 'missing']);
      const rows = (result.structuredContent as any).perQuery;
      expect(rows).toMatchObject([
        { query: 'alpha', shown: 1, total: 1, outcome: 'ok' },
        { query: 'missing', shown: 0, total: 0, symbolMatches: 0, outcome: 'empty' },
      ]);
      // The name that found nothing stays visible in the text a reader meets.
      expect(result.content[0]?.text).toContain('"missing": 0 reference(s)');
      expect(result.content[0]?.text).toContain('no such symbol in this file');
      // One name keeps the shape it always had: no breakdown, no extra noise.
      const singleName = await findReferencesTool.handler(
        { file_path: file, symbol_name: 'alpha' },
        client
      );
      expect((singleName.structuredContent as any).perQuery).toBeUndefined();
      expect(singleName.content[0]?.text).toContain('References (1/1) for "alpha"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('answers several definition names in one request, each count attributable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-multidef-'));
    const file = join(dir, 'multi.ts');
    writeFileSync(file, 'export const alpha = 1;\nexport const beta = alpha;\n');
    try {
      const asked: string[] = [];
      const client = asClient({
        findDefinitionsWithProvider: jest.fn(async (_file: string, name: string) => {
          asked.push(name);
          return name === 'missing'
            ? { outcome: 'ok', provider: 'lsp', value: [], matchedSymbols: 0 }
            : {
                outcome: 'ok',
                provider: 'lsp',
                value: [
                  {
                    uri: pathToUri(file),
                    range: { start: { line: 0, character: 13 }, end: { line: 0, character: 18 } },
                  },
                ],
                matchedSymbols: 1,
              };
        }),
        symbolKindToString: () => 'variable',
      });

      const result = await findDefinitionTool.handler(
        { file_path: file, symbol_name: ['alpha', 'missing'] },
        client
      );

      expect(asked).toEqual(['alpha', 'missing']);
      expect((result.structuredContent as any).perQuery).toMatchObject([
        { query: 'alpha', shown: 1, total: 1, outcome: 'ok' },
        { query: 'missing', shown: 0, total: 0, matchedSymbols: 0, outcome: 'empty' },
      ]);
      expect(result.content[0]?.text).toContain('"missing": 0 definition(s)');
      expect(result.content[0]?.text).toContain('  1: export const alpha = 1;');
      // One name keeps the shape it always had: no breakdown.
      const single = await findDefinitionTool.handler(
        { file_path: file, symbol_name: 'alpha' },
        client
      );
      expect((single.structuredContent as any).perQuery).toBeUndefined();
      expect(single.content[0]?.text).toContain('Found 1/1 definition(s) for "alpha"');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('follows every reference row with its source window, so no follow-up read is needed', async () => {
    // The measured shape this replaces: 100 reference rows, each a bare position,
    // and the very next action was a Read of the file they pointed at.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-refs-'));
    const file = join(dir, 'caller.ts');
    writeFileSync(
      file,
      'import { answer } from "./a.js";\n\nexport const used = answer();\nconst tail = 1;\n'
    );
    try {
      const locations = [
        {
          uri: pathToUri(file),
          range: { start: { line: 2, character: 21 }, end: { line: 2, character: 27 } },
        },
      ];
      const client = asClient({
        findSymbolsByName: jest.fn().mockResolvedValue({
          matches: [{ name: 'answer', kind: 12, position: { line: 0, character: 0 } }],
        }),
        findReferences: jest.fn().mockResolvedValue(locations),
        symbolKindToString: () => 'function',
      });
      const result = await findReferencesTool.handler(
        { file_path: file, symbol_name: 'answer' },
        client
      );
      expect(result.content[0]?.text).toContain('export const used = answer();');

      const bare = await findReferencesTool.handler(
        { file_path: file, symbol_name: 'answer', preview: false },
        client
      );
      expect(bare.content[0]?.text).not.toContain('export const used = answer();');
      expect(bare.content[0]?.text).toContain(':3:22');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('bounds workspace symbols with canonical totals and recovery', async () => {
    const symbols = ['alpha', 'beta', 'gamma'].map((name, index) => ({
      name,
      kind: 13,
      location: {
        uri: `file:///workspace/src/${name}.ts`,
        range: {
          start: { line: index, character: 0 },
          end: { line: index, character: name.length },
        },
      },
    }));
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'a', max_results: 2 },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: true }),
        symbolKindToString: () => 'variable',
      })
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      provider: 'lsp',
      shown: 2,
      total: 3,
      omitted: 1,
    });
    const spooled = (result.structuredContent as any).resultFile as string;
    expect(result.content[0]?.text).toContain(spooled);
    expect(JSON.parse(readFileSync(spooled, 'utf8')).symbols).toHaveLength(3);
  });

  it('answers several names in one call and keeps every count attributable', async () => {
    // The turn cost, not the server cost, is what several names used to spend: one
    // call per name. A merged answer would trade that for a worse defect -- a zero
    // nobody can attribute -- so every name reports its own count.
    const symbolFor = (name: string) => ({
      name,
      kind: 13,
      location: {
        uri: `file:///workspace/src/${name}.ts`,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: name.length } },
      },
    });
    const workspaceSymbol = jest.fn(async (query: string) => ({
      symbols: query === 'present' ? [symbolFor('present')] : [],
      readinessConfirmed: true,
    }));
    const result = await findWorkspaceSymbolsTool.handler(
      { query: ['present', 'absent'] },
      asClient({ workspaceSymbol, symbolKindToString: () => 'variable' })
    );

    // One request per name: the protocol takes one string and defines no alternation.
    expect(workspaceSymbol.mock.calls.map((call) => call[0])).toEqual(['present', 'absent']);
    expect(result.structuredContent).toMatchObject({ outcome: 'ok', shown: 1, total: 1 });
    expect((result.structuredContent as any).perQuery).toMatchObject([
      { query: 'present', shown: 1, total: 1, outcome: 'ok' },
      { query: 'absent', shown: 0, total: 0, outcome: 'empty' },
    ]);
    // The absent name must stay visible in the text a reader actually meets, and
    // its zero must still route to the tier that can prove repository absence.
    expect(result.content[0]?.text).toContain('"absent": 0 match(es)');
    expect((result.structuredContent as any).recovery).toContain('"absent"');
    expect((result.structuredContent as any).recovery).toContain('ast_search');
  });

  it("carries each row's declaration line by default, and drops it only on request", async () => {
    // Without the line, a row says only WHERE a name the caller already knew is,
    // so choosing between candidates costs a file read each. One line answers it.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-preview-'));
    const file = join(dir, 'health.ts');
    writeFileSync(
      file,
      'const other = 1;\nexport function HealthView(props: Props) {\n  return null;\n}\n'
    );
    try {
      const symbols = [
        {
          name: 'HealthView',
          kind: 12,
          location: {
            uri: pathToUri(file),
            range: { start: { line: 1, character: 16 }, end: { line: 1, character: 26 } },
          },
        },
      ];
      const client = asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: true }),
        symbolKindToString: () => 'function',
      });

      const withPreview = await findWorkspaceSymbolsTool.handler({ query: 'HealthView' }, client);
      expect(withPreview.content[0]?.text).toContain('export function HealthView(props: Props) {');

      const withoutPreview = await findWorkspaceSymbolsTool.handler(
        { query: 'HealthView', preview: false },
        client
      );
      expect(withoutPreview.content[0]?.text).not.toContain('export function HealthView(props');
      expect(withoutPreview.content[0]?.text).toContain('HealthView');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders the window in the grep convention, contiguously, marking the matched span', async () => {
    // One rendering owner, one convention: `:` is a matched line and `-` is context,
    // the same shape `path:line:col` already uses above it. A per-tool marker is
    // exactly the drift this owner exists to prevent, so the format is pinned here.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-window-'));
    const file = join(dir, 'shape.ts');
    writeFileSync(
      file,
      'const before = 1;\n\nexport function target() {\n  return 2;\n}\n\nconst after = 3;\n'
    );
    try {
      const symbols = [
        {
          name: 'target',
          kind: 12,
          location: {
            uri: pathToUri(file),
            range: { start: { line: 2, character: 16 }, end: { line: 4, character: 1 } },
          },
        },
      ];
      const result = await findWorkspaceSymbolsTool.handler(
        { query: 'target' },
        asClient({
          workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: true }),
          symbolKindToString: () => 'function',
        })
      );
      const lines = (result.content[0]?.text ?? '').split('\n');
      expect(lines).toContain('  1- const before = 1;');
      // The blank line is rendered, not skipped: a gap in the numbering reads as a
      // defect and saves nothing measurable.
      expect(lines).toContain('  2- ');
      expect(lines).toContain('  3: export function target() {');
      // A symbol row marks its declaration line, not its whole body: marking the
      // span would print every line of a two-hundred-line function to say where it
      // starts, which is the opposite of the read this window replaces.
      expect(lines).toContain('  4-   return 2;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps a row whose file cannot be read, and only loses its preview', async () => {
    // The preview is an enrichment. Losing the answer because a path moved would
    // turn a real match into a silent absence, which is the worse failure.
    const symbols = [
      {
        name: 'Gone',
        kind: 12,
        location: {
          uri: 'file:///workspace/does-not-exist.ts',
          range: { start: { line: 4, character: 0 }, end: { line: 4, character: 4 } },
        },
      },
    ];
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'Gone' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: true }),
        symbolKindToString: () => 'function',
      })
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'ok', shown: 1 });
    expect(result.content[0]?.text).toContain('/workspace/does-not-exist.ts:5:1');
  });

  it("keeps duplicate names as asked, so the breakdown lines up with the caller's array", async () => {
    // Collapsing ['same','same'] would save one request and silently return fewer
    // rows than the caller listed, spending the shared bound differently. A caller
    // comparing its array with the answer would find them misaligned and nothing
    // in the answer would say why.
    const asked: string[] = [];
    const workspaceSymbol = jest.fn(async (query: string) => {
      asked.push(query);
      return { symbols: [], readinessConfirmed: true };
    });
    const result = await findWorkspaceSymbolsTool.handler(
      { query: ['same', 'same', 'other'] },
      asClient({ workspaceSymbol, symbolKindToString: () => 'variable' })
    );
    expect(asked).toEqual(['same', 'same', 'other']);
    expect((result.structuredContent as any).perQuery.map((row: any) => row.query)).toEqual([
      'same',
      'same',
      'other',
    ]);
  });

  it('refuses a malformed name list before issuing any provider request', async () => {
    const workspaceSymbol = jest.fn();
    for (const query of [[], ['ok', '   '], ['ok', 42]]) {
      await expect(
        findWorkspaceSymbolsTool.handler(
          { query },
          asClient({ workspaceSymbol, symbolKindToString: () => 'variable' })
        )
      ).rejects.toThrow();
    }
    expect(workspaceSymbol).not.toHaveBeenCalled();
  });

  it('keeps one name answering exactly as it did before the batch form existed', async () => {
    const workspaceSymbol = jest.fn().mockResolvedValue({
      symbols: [
        {
          name: 'alpha',
          kind: 13,
          location: {
            uri: 'file:///workspace/src/alpha.ts',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          },
        },
      ],
      readinessConfirmed: true,
    });
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'alpha' },
      asClient({ workspaceSymbol, symbolKindToString: () => 'variable' })
    );
    expect(result.content[0]?.text).toContain('matching "alpha"');
    // No breakdown for one name: the header already carries its count, and a
    // second copy of it is noise in every single-name answer ever returned.
    expect((result.structuredContent as any).perQuery).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ outcome: 'ok', shown: 1, total: 1 });
  });

  it('bounds a long name list by rows, not by an invented name ceiling', async () => {
    // No cap on how many names one call may ask: `max_results` already bounds the
    // ANSWER, and a name count refused at 21 would be a number nothing measured.
    const names = Array.from({ length: 50 }, (_, index) => `name${index}`);
    const result = await findWorkspaceSymbolsTool.handler(
      { query: names, max_results: 1 },
      asClient({
        workspaceSymbol: jest.fn(async (query: string) => ({
          symbols: [
            {
              name: query,
              kind: 13,
              location: {
                uri: `file:///workspace/src/${query}.ts`,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } },
              },
            },
          ],
          readinessConfirmed: true,
        })),
        symbolKindToString: () => 'variable',
      })
    );
    expect((result.structuredContent as any).perQuery).toHaveLength(50);
    expect(result.structuredContent).toMatchObject({ shown: 1, total: 50, omitted: 49 });
    const spooled = (result.structuredContent as any).resultFile as string;
    rmSync(spooled, { force: true });
  });

  it('spends the row bound in asked order, so a later name is omitted rather than zero', async () => {
    // The dangerous failure is silent: if the bound simply truncated the merged
    // list, the last name would read as a clean zero instead of an unread answer.
    const rowsFor = (name: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        name: `${name}${index}`,
        kind: 13,
        location: {
          uri: `file:///workspace/src/${name}${index}.ts`,
          range: { start: { line: index, character: 0 }, end: { line: index, character: 3 } },
        },
      }));
    const result = await findWorkspaceSymbolsTool.handler(
      { query: ['first', 'second'], max_results: 2 },
      asClient({
        workspaceSymbol: jest.fn(async (query: string) => ({
          symbols: rowsFor(query, query === 'first' ? 2 : 3),
          readinessConfirmed: true,
        })),
        symbolKindToString: () => 'variable',
      })
    );
    expect((result.structuredContent as any).perQuery).toMatchObject([
      { query: 'first', shown: 2, omitted: 0, outcome: 'ok' },
      // Rows exist and were cut by the SHARED bound, so this name is partial.
      // Reporting it as `empty` would be the false zero the breakdown prevents.
      { query: 'second', shown: 0, total: 3, omitted: 3, outcome: 'partial' },
    ]);
    expect(result.structuredContent).toMatchObject({ shown: 2, total: 5, omitted: 3 });
    const spooled = (result.structuredContent as any).resultFile as string;
    expect(JSON.parse(readFileSync(spooled, 'utf8')).perQuery).toHaveLength(2);
    rmSync(spooled, { force: true });
  });

  it('reports zero rows as a SCOPED empty only when the provider is confirmed answering', async () => {
    // `empty` claims only that nothing matched among the files this provider
    // loaded. It must still be reportable -- retyping every negative as `stale`
    // would leave no way to answer "not here" at all.
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'nothing' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols: [], readinessConfirmed: true }),
        symbolKindToString: () => 'variable',
      })
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'empty', shown: 0, total: 0 });
    // A confirmed zero is a real negative for the loaded program graph and says
    // so; repository-wide absence (excluded folders, other languages) is routed
    // to the structural tier rather than to a second LSP call.
    expect((result.structuredContent as any).recovery).toContain('ast_search');
    expect((result.structuredContent as any).recovery).not.toContain('Retry');
    expect(result.content[0]?.text).toContain('no match in the loaded program graph');
  });

  it('reports zero rows as STALE while the provider is not confirmed answering', async () => {
    // The measured defect: an unindexed navto answers [] and it was typed as
    // a negative, so an existing symbol read as "no match" with exit 0.
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'deriveUnifiedAgentState' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols: [], readinessConfirmed: false }),
        symbolKindToString: () => 'variable',
      })
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'stale', shown: 0 });
    // Stale means "not an answer yet": the act is to retry, not to search elsewhere.
    expect((result.structuredContent as any).recovery).toContain('Retry');
    expect((result.structuredContent as any).recovery).not.toContain('ast_search');
    expect(result.content[0]?.text).toContain('index still loading');
  });

  it('keeps rows found while unconfirmed, but does not call the answer complete', async () => {
    const symbols = [
      {
        name: 'found',
        kind: 13,
        location: {
          uri: 'file:///workspace/src/found.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        },
      },
    ];
    const result = await findWorkspaceSymbolsTool.handler(
      { query: 'found' },
      asClient({
        workspaceSymbol: jest.fn().mockResolvedValue({ symbols, readinessConfirmed: false }),
        symbolKindToString: () => 'variable',
      })
    );
    expect(result.structuredContent).toMatchObject({ outcome: 'ok', shown: 1 });
    expect((result.structuredContent as any).readinessConfirmed).toBe(false);
  });

  it('carries the offending source line with a diagnostic, reading each file once', async () => {
    // A diagnostic without its line is a message about code the reader cannot see,
    // so acting on it costs a read every time. Many diagnostics in one file must
    // still cost ONE read: the window owner is created per call, not per row.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-diag-'));
    const file = join(dir, 'broken.ts');
    writeFileSync(
      file,
      'const a = 1;\nconst b: string = 2;\nconst c: number = "x";\nconst d = 4;\n'
    );
    try {
      const diagnostics = [
        {
          severity: 1,
          message: 'not assignable',
          range: { start: { line: 1, character: 6 }, end: { line: 1, character: 7 } },
        },
        {
          severity: 1,
          message: 'not assignable',
          range: { start: { line: 2, character: 6 }, end: { line: 2, character: 7 } },
        },
      ];
      const result = await getDiagnosticsTool.handler(
        { file_path: file },
        asClient({
          getDiagnosticsReport: jest
            .fn()
            .mockResolvedValue({ diagnostics, freshness: { status: 'current' } }),
        })
      );
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('const b: string = 2;');
      expect(text).toContain('const c: number = "x";');
      // The matched line is marked, so a reader never counts lines to find it.
      expect(text).toContain('2:');

      const positionsOnly = await getDiagnosticsTool.handler(
        { file_path: file, preview: false },
        asClient({
          getDiagnosticsReport: jest
            .fn()
            .mockResolvedValue({ diagnostics, freshness: { status: 'current' } }),
        })
      );
      expect(positionsOnly.content[0]?.text).not.toContain('const b: string = 2;');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps the window on unverified and stale diagnostic rows, not just on current ones', async () => {
    // A row marked "may be stale" still points at real code, and the caller still
    // has to look at it. Dropping the window on the failure path would force the
    // exact read this answer exists to replace, precisely when the caller is least
    // sure what is going on.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-stale-'));
    const file = join(dir, 'unverified.ts');
    writeFileSync(file, 'const head = 0;\nconst suspect: number = "text";\nconst tail = 2;\n');
    try {
      const rows = [
        {
          severity: 1,
          message: 'not assignable',
          range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
        },
      ];
      // The freshness-unknown path: the provider answered, but nothing certifies it.
      const staleResult = await getDiagnosticsTool.handler(
        { file_path: file },
        asClient({
          getDiagnosticsReport: jest
            .fn()
            .mockResolvedValue({ diagnostics: rows, freshness: { status: 'unknown' } }),
        })
      );
      expect(staleResult.structuredContent).toMatchObject({ outcome: 'stale' });
      expect(staleResult.content[0]?.text).toContain('const suspect: number = "text";');

      // The throw path, where the provider hands back rows it cannot verify.
      const thrown = Object.assign(new Error('LSP_DIAGNOSTICS_UNKNOWN: provider is indexing'), {
        diagnostics: rows,
        status: 'unknown',
      });
      const errorResult = await getDiagnosticsTool.handler(
        { file_path: file },
        asClient({
          getDiagnosticsReport: jest.fn().mockRejectedValue(thrown),
        })
      );
      expect(errorResult.structuredContent).toMatchObject({ outcome: 'stale' });
      expect(errorResult.content[0]?.text).toContain('Unverified provider rows:');
      expect(errorResult.content[0]?.text).toContain('const suspect: number = "text";');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('renders ast_search matches through the shared window and admits its width first', async () => {
    // The structural tier is the one that answers when no language server can, so
    // its rows carry the same window as every semantic row -- and its admission is
    // owed at the same place, before the scan that is the expensive part.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-ast-'));
    const file = join(dir, 'shape.ts');
    writeFileSync(file, 'const before = 0;\nexport const target = 1;\nconst after = 2;\n');
    try {
      const scans: unknown[] = [];
      const client = asClient({
        astSearch: jest.fn(async (input: unknown) => {
          scans.push(input);
          return {
            outcome: 'ok',
            provider: 'tree-sitter',
            language: 'typescript',
            filesScanned: 1,
            truncated: false,
            indexCapped: false,
            perPattern: [{ pattern: 'target', matches: 1, completeness: 'exact' }],
            matches: [
              {
                file,
                range: { start: { line: 1, character: 13 }, end: { line: 1, character: 19 } },
                text: 'target',
                captures: [],
                recovered: false,
              },
            ],
          };
        }),
      });

      const ok = await astSearchTool.handler({ pattern: 'target', language: 'typescript' }, client);
      // A bare name matches the identifier node, so its text is the name the caller
      // already typed; the window is what makes the row worth reading.
      expect(ok.content[0]?.text).toContain('  2: export const target = 1;');
      expect(ok.content[0]?.text).toContain('  1- const before = 0;');

      const bare = await astSearchTool.handler(
        { pattern: 'target', language: 'typescript', preview: false },
        client
      );
      expect(bare.content[0]?.text).not.toContain('const before = 0;');
      expect(bare.content[0]?.text).toContain('target');

      const scansBefore = scans.length;
      await expect(
        astSearchTool.handler({ pattern: 'target', language: 'typescript', preview: -4 }, client)
      ).rejects.toThrow();
      // The refusal must cost no scan: that is the expensive half of this answer.
      expect(scans.length).toBe(scansBefore);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('marks every line of a multi-line ast_search match, and only those lines', async () => {
    // A shape pattern spans several lines, so the end line must reach the window.
    // A single-line fixture cannot see that: passing start.line twice would render
    // identically and the regression would ship. The blank line inside the span is
    // deliberate -- it must be marked as part of the match, while the blank line
    // outside it must be rendered as context, not skipped.
    const dir = mkdtempSync(join(tmpdir(), 'cclsp-span-'));
    const file = join(dir, 'span.ts');
    writeFileSync(
      file,
      [
        'const before = 0;',
        '',
        'export function target() {',
        '',
        '  return 1;',
        '}',
        '',
        'const after = 2;',
        '',
      ].join('\n')
    );
    try {
      const client = asClient({
        astSearch: jest.fn(async () => ({
          outcome: 'ok',
          provider: 'tree-sitter',
          language: 'typescript',
          filesScanned: 1,
          truncated: false,
          indexCapped: false,
          perPattern: [
            { pattern: 'function $NAME() { $$$BODY }', matches: 1, completeness: 'exact' },
          ],
          matches: [
            {
              file,
              // Lines 3..6 one-indexed: the whole declaration, blank line included.
              range: { start: { line: 2, character: 0 }, end: { line: 5, character: 1 } },
              text: 'export function target() {\n\n  return 1;\n}',
              captures: [],
              recovered: false,
            },
          ],
        })),
      });

      const result = await astSearchTool.handler(
        { pattern: 'function $NAME() { $$$BODY }', language: 'typescript', preview: 1 },
        client
      );
      const lines = (result.content[0]?.text ?? '').split('\n');
      // Context above, then every line of the span marked, then context below.
      expect(lines).toContain('  2- ');
      expect(lines).toContain('  3: export function target() {');
      expect(lines).toContain('  4: ');
      expect(lines).toContain('  5:   return 1;');
      expect(lines).toContain('  6: }');
      expect(lines).toContain('  7- ');
      // Nothing beyond the window, and no line outside the span wearing the mark.
      expect(lines).not.toContain('  8- const after = 2;');
      expect(lines.filter((line) => line.trimStart().startsWith('8:'))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses an invalid preview width BEFORE the provider is asked anything', async () => {
    // A refusal issued after the scan has already run costs the whole expensive
    // part of the answer. Every location tool admits the width at entry, so the
    // provider call count for an invalid width is exactly zero.
    const calls: string[] = [];
    const client = asClient({
      getDiagnosticsReport: jest.fn(async () => {
        calls.push('diagnostics');
        return { diagnostics: [], freshness: { status: 'current' } };
      }),
      workspaceSymbol: jest.fn(async () => {
        calls.push('workspaceSymbol');
        return { symbols: [], readinessConfirmed: true };
      }),
      findSymbolsByName: jest.fn(async () => {
        calls.push('findSymbolsByName');
        return { matches: [] };
      }),
      findReferences: jest.fn(async () => {
        calls.push('findReferences');
        return [];
      }),
      prepareCallHierarchy: jest.fn(async () => {
        calls.push('prepareCallHierarchy');
        return [];
      }),
      incomingCalls: jest.fn(async () => {
        calls.push('incomingCalls');
        return [];
      }),
      outgoingCalls: jest.fn(async () => {
        calls.push('outgoingCalls');
        return [];
      }),
      getDocumentSymbolsWithProvider: jest.fn(async () => {
        // The position lookup a call-hierarchy query runs FIRST. It must not run
        // either, or the refusal still arrives after real work -- and it is the
        // call that made the mutation probe pass while the admission was late.
        calls.push('getDocumentSymbolsWithProvider');
        return {
          provider: 'lsp' as const,
          symbols: [
            {
              name: 'answer',
              kind: 12,
              range: { start: { line: 0, character: 0 }, end: { line: 3, character: 1 } },
              selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
              children: [],
            },
          ],
        };
      }),
      symbolKindToString: () => 'function',
    });

    for (const invocation of [
      () => getDiagnosticsTool.handler({ file_path: '/workspace/src/a.ts', preview: -1 }, client),
      () => findWorkspaceSymbolsTool.handler({ query: 'answer', preview: 99 }, client),
      () =>
        findReferencesTool.handler(
          { file_path: '/workspace/src/a.ts', symbol_name: 'answer', preview: 1.5 },
          client
        ),
      // Both call-hierarchy directions: each runs a POSITION lookup before its own
      // provider request, so a late refusal here would waste two round trips.
      () =>
        getIncomingCallsTool.handler(
          { file_path: '/workspace/src/a.ts', query: 'answer', preview: -2 },
          client
        ),
      () =>
        getOutgoingCallsTool.handler(
          { file_path: '/workspace/src/a.ts', query: 'answer', preview: 21 },
          client
        ),
      () =>
        prepareCallHierarchyTool.handler(
          { file_path: '/workspace/src/a.ts', query: 'answer', preview: 2.5 },
          client
        ),
    ]) {
      await expect(invocation()).rejects.toThrow();
    }
    expect(calls).toEqual([]);
  });

  it('returns typed diagnostics including the source file for range normalization', async () => {
    const diagnostic = {
      severity: 1,
      message: 'broken',
      range: { start: { line: 2, character: 1 }, end: { line: 2, character: 4 } },
    };
    const result = await getDiagnosticsTool.handler(
      { file_path: '/workspace/src/a.ts' },
      asClient({
        getDiagnosticsReport: jest
          .fn()
          .mockResolvedValue({ diagnostics: [diagnostic], freshness: { status: 'current' } }),
      })
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      provider: 'lsp',
      file: '/workspace/src/a.ts',
      diagnostics: [diagnostic],
      shown: 1,
      total: 1,
      omitted: 0,
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

  it('reads one shared source file once across a multiple-action handler result', async () => {
    const file = '/workspace/shared.ts';
    const reads: string[] = [];
    const edit = (newText: string) => ({
      changes: {
        [pathToUri(file)]: [
          {
            range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
            newText,
          },
        ],
      },
    });
    const tool = createGetCodeActionsTool((path) => {
      reads.push(path);
      return 'const value = 1;\n';
    });
    const result = await tool.handler(
      {
        file_path: file,
        start_line: 1,
        start_character: 1,
        end_line: 1,
        end_character: 16,
      },
      asClient({
        getCodeActions: jest.fn().mockResolvedValue([
          { title: 'First', edit: edit('first') },
          { title: 'Second', edit: edit('second') },
        ]),
      })
    );

    expect(result.structuredContent?.actions).toEqual([
      expect.objectContaining({
        preview: [expect.objectContaining({ source: ['  1: const value = 1;', '  2- '] })],
      }),
      expect.objectContaining({
        preview: [expect.objectContaining({ source: ['  1: const value = 1;', '  2- '] })],
      }),
    ]);
    expect(reads).toEqual([file]);
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
      expect(preview.structuredContent).toMatchObject({
        applied: false,
        title: 'Rename local',
        preview: [expect.objectContaining({ source: ['  1: const value = 1;', '  2- '] })],
      });
      expect(preview.content[0]?.text).toContain(
        `Candidate ID: ${preview.structuredContent?.candidateId}`
      );
      expect(preview.content[0]?.text).toContain('const value = 1;');
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
          candidate_id: preview.structuredContent?.candidateId,
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
    };
    try {
      const preview = await getCodeActionsTool.handler(
        { ...baseArgs, title: 'Text document change' },
        client
      );
      const applied = await getCodeActionsTool.handler(
        {
          ...baseArgs,
          title: 'Text document change',
          apply: true,
          candidate_id: preview.structuredContent?.candidateId,
        },
        client
      );
      expect(applied.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
      expect(readFileSync(file, 'utf8')).toBe('const renamed = 1;\n');

      const rejected = await getCodeActionsTool.handler(
        { ...baseArgs, title: 'Resource change', apply: false },
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
      expect(preview.content[0]?.text).toContain(
        `Candidate ID: ${preview.structuredContent?.candidateId}`
      );
      expect(preview.content[0]?.text).toContain("import { value } from './old';");
      expect(readFileSync(oldPath, 'utf8')).toContain('value');
      expect(() => readFileSync(newPath, 'utf8')).toThrow();
      expect(didRenameFiles).not.toHaveBeenCalled();

      const applied = await renameFileTool.handler(
        {
          old_path: oldPath,
          new_path: newPath,
          dry_run: false,
          candidate_id: preview.structuredContent?.candidateId,
        },
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

  it('keeps a small result inline when two projections share the same row object', () => {
    // workspace_symbols deliberately projects one provider row into the aggregate
    // symbols list and its per-query list. That is a shared reference, not a JSON
    // cycle: JSON.stringify emits it twice and the size guard must count it twice.
    const shared = { name: 'alpha', location: { line: 1, character: 1 } };
    const result = boundToolResult(
      {
        content: [{ type: 'text', text: 'one small answer' }],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          symbols: [shared],
          perQuery: [{ query: 'alpha', symbols: [shared] }],
        },
      },
      4_096
    );

    expect(result.structuredContent).not.toHaveProperty('bounded');
    expect(result.structuredContent).not.toHaveProperty('resultFile');
    expect(result.content[0]?.text).toBe('one small answer');
  });

  it('still refuses a real JSON cycle without looping', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const result = boundToolResult(
      {
        content: [{ type: 'text', text: 'cyclic' }],
        structuredContent: { outcome: 'ok', provider: 'lsp', cyclic },
      },
      4_096
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'unavailable',
      code: 'TOOL_RESULT_SPOOL_FAILED',
    });
  });

  it('spools an oversized result and points at it instead of refusing the answer', () => {
    const rows = Array.from({ length: 2_000 }, (_, index) => ({
      name: `symbol${index}`,
      detail: 'x'.repeat(200),
    }));
    const bounded = boundToolResult(
      {
        content: [{ type: 'text', text: `head line\n${'row\n'.repeat(5_000)}` }],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          shown: 2_000,
          total: 2_000,
          omitted: 0,
          symbols: rows,
        },
      },
      4_096
    );
    expect(bounded.isError).toBeUndefined();
    expect(bounded.structuredContent).toMatchObject({
      outcome: 'ok',
      provider: 'lsp',
      bounded: true,
      total: 2_000,
    });
    const spooled = (bounded.structuredContent as any).resultFile as string;
    expect(bounded.content[0]?.text.startsWith('head line')).toBe(true);
    expect(bounded.content[0]?.text).toContain(spooled);
    const complete = JSON.parse(readFileSync(spooled, 'utf8'));
    expect(complete.structuredContent.symbols).toHaveLength(2_000);
  });
});
