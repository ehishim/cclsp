import { describe, expect, it, jest } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LSPClient } from './lsp-client.js';
import { LspToolOutcomeError } from './lsp/capabilities.js';
import { positionResolutionResult, resolveToolPosition } from './tools/position-resolver.js';

async function withClient(
  action: (root: string, client: LSPClient) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cclsp-fallback-'));
  const config = join(root, 'cclsp.json');
  await writeFile(config, JSON.stringify({ servers: [] }));
  await writeFile(join(root, 'sample.py'), 'class Box:\n    def run(self):\n        return 1\n');
  await writeFile(join(root, 'sample.txt'), 'plain text\n');
  const client = new LSPClient(config, root);
  try {
    await action(root, client);
  } finally {
    await client.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

function unsupported(method: string): LspToolOutcomeError {
  return new LspToolOutcomeError({
    outcome: 'unsupported',
    code: 'LSP_METHOD_UNSUPPORTED',
    method,
    server: 'fixture-server',
  });
}

describe('honest AST fallback', () => {
  it('falls back for an unconfigured document-symbol and definition path', async () => {
    await withClient(async (root, client) => {
      const file = join(root, 'sample.py');
      const symbols = await client.getDocumentSymbolsWithProvider(file);
      expect(symbols.outcome).toBe('ok');
      if (symbols.outcome === 'ok') {
        expect(symbols.provider).toBe('tree-sitter');
        expect(symbols.value.map((symbol) => symbol.name)).toEqual(['Box']);
      }

      const definitions = await client.findDefinitionsWithProvider(file, 'run', 'method');
      expect(definitions).toMatchObject({
        outcome: 'ok',
        provider: 'tree-sitter',
        value: [{ uri: expect.stringContaining('sample.py') }],
      });
    });
  });

  it('returns provider none when neither LSP nor an AST grammar can answer', async () => {
    await withClient(async (root, client) => {
      await expect(
        client.getDocumentSymbolsWithProvider(join(root, 'sample.txt'))
      ).resolves.toEqual({
        outcome: 'unavailable',
        provider: 'none',
        code: 'AST_LANGUAGE_UNSUPPORTED',
        reason: expect.stringContaining('No AST grammar'),
      });
    });
  });

  it('preserves unsupported LSP provenance when AST fallback is unavailable', async () => {
    await withClient(async (root, client) => {
      const file = join(root, 'sample.txt');
      client.getDocumentSymbols = jest
        .fn()
        .mockRejectedValue(unsupported('textDocument/documentSymbol'));

      const symbols = await client.getDocumentSymbolsWithProvider(file);
      expect(symbols).toMatchObject({
        outcome: 'unavailable',
        provider: 'none',
        code: 'LSP_METHOD_UNSUPPORTED',
        method: 'textDocument/documentSymbol',
        server: 'fixture-server',
        reason: expect.stringContaining('LSP_METHOD_UNSUPPORTED'),
        fallback: { code: 'AST_LANGUAGE_UNSUPPORTED', reason: expect.any(String) },
      });

      const resolution = await resolveToolPosition(file, { query: 'plain' }, client);
      expect(resolution).toMatchObject({
        outcome: 'unavailable',
        code: 'LSP_METHOD_UNSUPPORTED',
        method: 'textDocument/documentSymbol',
        fallback: { code: 'AST_LANGUAGE_UNSUPPORTED' },
      });
      if (resolution.outcome !== 'unavailable') throw new Error('expected unavailable');
      expect(positionResolutionResult(resolution, file)).toMatchObject({
        isError: true,
        structuredContent: {
          code: 'LSP_METHOD_UNSUPPORTED',
          method: 'textDocument/documentSymbol',
          server: 'fixture-server',
          fallback: { code: 'AST_LANGUAGE_UNSUPPORTED' },
        },
      });

      client.findSymbolsByName = jest.fn().mockResolvedValue({
        matches: [{ name: 'plain', kind: 13, position: { line: 0, character: 0 } }],
      });
      client.findDefinition = jest.fn().mockRejectedValue(unsupported('textDocument/definition'));
      await expect(client.findDefinitionsWithProvider(file, 'plain')).resolves.toMatchObject({
        outcome: 'unavailable',
        code: 'LSP_METHOD_UNSUPPORTED',
        method: 'textDocument/definition',
        server: 'fixture-server',
        fallback: { code: 'AST_LANGUAGE_UNSUPPORTED' },
      });
    });
  });

  it('preserves supported empty as LSP evidence', async () => {
    await withClient(async (root, client) => {
      client.getDocumentSymbols = jest.fn().mockResolvedValue([]);
      client.findSymbolsByName = jest.fn().mockResolvedValue({ matches: [] });
      // Deliberately a file that declares nothing. This guard exists so a true negative is never
      // retyped into a gap, and that is only what an empty answer means when the file is in fact
      // empty. The earlier fixture asserted this over sample.py, which declares Box and run, so it
      // required a demonstrably wrong empty to be preserved as evidence about the code.
      const file = join(root, 'empty.py');
      await writeFile(file, '# nothing is declared in this file\n');
      await expect(client.getDocumentSymbolsWithProvider(file)).resolves.toEqual({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
      });
      await expect(client.findDefinitionsWithProvider(file, 'run')).resolves.toMatchObject({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
        matchedSymbols: 0,
      });
    });
  });

  it('falls back only for method unsupported and propagates other failures', async () => {
    await withClient(async (root, client) => {
      const file = join(root, 'sample.py');
      client.getDocumentSymbols = jest
        .fn()
        .mockRejectedValueOnce(unsupported('textDocument/documentSymbol'));
      await expect(client.getDocumentSymbolsWithProvider(file)).resolves.toMatchObject({
        outcome: 'ok',
        provider: 'tree-sitter',
      });

      client.getDocumentSymbols = jest.fn().mockRejectedValueOnce(new Error('cold timeout'));
      await expect(client.getDocumentSymbolsWithProvider(file)).rejects.toThrow('cold timeout');
    });
  });

  it('uses AST declarations to resolve a query while semantic references remain LSP-only', async () => {
    await withClient(async (root, client) => {
      const file = join(root, 'sample.py');
      await expect(resolveToolPosition(file, { query: 'Box.run' }, client)).resolves.toMatchObject({
        outcome: 'resolved',
        provider: 'tree-sitter',
        candidate: { qualifiedName: 'Box.run' },
      });
      await expect(client.findReferences(file, { line: 1, character: 8 })).rejects.toThrow(
        'No LSP server configured'
      );
    });
  });
});

describe('a still-indexing server answering empty is not an answer', () => {
  it('settles a caller-named file with tree-sitter instead of reporting its symbols absent', async () => {
    await withClient(async (root, client) => {
      const file = join(root, 'cold.ts');
      await writeFile(file, 'export function isUnder(a: string, b: string) {\n  return a === b;\n}\n');

      // The failure this guards: the server returns successfully with zero symbols while it is
      // still indexing, so nothing throws and the fallback tier is never reached.
      const spy = jest.spyOn(client, 'getDocumentSymbols').mockResolvedValue([]);

      const symbols = await client.getDocumentSymbolsWithProvider(file);
      expect(symbols.outcome).toBe('ok');
      if (symbols.outcome === 'ok') {
        expect(symbols.provider).toBe('tree-sitter');
        expect(symbols.value.map((symbol) => symbol.name)).toContain('isUnder');
      }

      // And the caller-facing consequence: resolving by name must locate it, not refuse.
      const resolved = await resolveToolPosition(file, { query: 'isUnder' }, client);
      expect(resolved.outcome).not.toBe('not_found');

      spy.mockRestore();
    });
  });

  it('leaves a genuinely empty file reported empty by the server that answered', async () => {
    await withClient(async (root, client) => {
      const file = join(root, 'blank.ts');
      await writeFile(file, '// no declarations here\n');
      const spy = jest.spyOn(client, 'getDocumentSymbols').mockResolvedValue([]);

      const symbols = await client.getDocumentSymbolsWithProvider(file);
      expect(symbols).toMatchObject({ outcome: 'ok', provider: 'lsp', value: [] });

      spy.mockRestore();
    });
  });
});
