import { describe, expect, it, jest } from 'bun:test';
import type { LSPClient } from './lsp-client.js';
import { astSearchTool, astTools } from './tools/ast-search.js';

function client(result: Record<string, unknown>): LSPClient {
  return {
    astSearch: jest.fn().mockResolvedValue(result),
  } as unknown as LSPClient;
}

describe('ast_search tool', () => {
  it('registers structural search and rewrite exactly once', () => {
    expect(astTools.map((tool) => tool.name)).toEqual(['ast_search', 'code_rewrite']);
  });
  it('requires pattern and language in the public schema', () => {
    expect(astSearchTool.inputSchema).toMatchObject({ required: ['pattern', 'language'] });
  });

  it('projects successful structured data and readable one-indexed text', async () => {
    const mock = client({
      outcome: 'ok',
      provider: 'tree-sitter',
      language: 'typescript',
      matches: [
        {
          file: '/root/sample.ts',
          range: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
          text: 'const x = 1',
          captures: [
            {
              name: 'NAME',
              variadic: false,
              range: { start: { line: 1, character: 8 }, end: { line: 1, character: 9 } },
              text: 'x',
            },
          ],
        },
      ],
      truncated: false,
      effectiveMaxResults: 100,
      filesScanned: 1,
      filesSkippedOversized: 0,
      indexCapped: false,
      partial: false,
      parseFailureCount: 0,
      failedFiles: [],
      perPattern: [{ pattern: 'const $NAME = $VALUE', matches: 1 }],
    });
    const result = await astSearchTool.handler(
      { pattern: 'const $NAME = $VALUE', language: 'typescript' },
      mock
    );
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      provider: 'tree-sitter',
      matches: [{ file: '/root/sample.ts' }],
    });
    expect(result.content[0]?.text).toContain('/root/sample.ts:2:3');
    expect(result.content[0]?.text).toContain('$NAME @ 2:9 = x');
  });

  it('renders an incomplete zero as unknown and non-successful', async () => {
    const result = await astSearchTool.handler(
      { pattern: ['confirmed', 'unproven'], language: 'typescript' },
      client({
        outcome: 'partial',
        code: 'AST_SEARCH_PARTIAL',
        recovery: 'Retry with a narrower path that parses completely.',
        provider: 'tree-sitter',
        language: 'typescript',
        matches: [
          {
            file: '/root/confirmed.ts',
            range: { start: { line: 0, character: 16 }, end: { line: 0, character: 25 } },
            text: 'confirmed',
            captures: [],
          },
        ],
        truncated: false,
        effectiveMaxResults: 100,
        filesScanned: 4,
        filesSkippedOversized: 0,
        indexCapped: false,
        partial: true,
        parseFailureCount: 1,
        failedFiles: [{ file: '/root/failed.ts', code: 'AST_PARSE_FAILED' }],
        perPattern: [
          { pattern: 'confirmed', matches: 2, completeness: 'lower-bound' },
          { pattern: 'unproven', completeness: 'unknown' },
        ],
      })
    );
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      outcome: 'partial',
      code: 'AST_SEARCH_PARTIAL',
    });
    expect(result.content[0]?.text).toContain('confirmed: at least 2 match(es)');
    expect(result.content[0]?.text).toContain('unproven: unknown');
    expect(result.content[0]?.text).toContain('/root/failed.ts');
    expect(result.content[0]?.text).toContain('/root/confirmed.ts:1:17');
    expect(result.content[0]?.text).toContain('Recovery: Retry with a narrower path');
    expect(result.content[0]?.text).not.toContain('0 match(es)');
  });

  it('preserves an exact zero when the scan is complete', async () => {
    const result = await astSearchTool.handler(
      { pattern: 'absent', language: 'typescript' },
      client({
        outcome: 'ok',
        provider: 'tree-sitter',
        language: 'typescript',
        matches: [],
        truncated: false,
        effectiveMaxResults: 100,
        filesScanned: 1,
        filesSkippedOversized: 0,
        indexCapped: false,
        partial: false,
        parseFailureCount: 0,
        failedFiles: [],
        perPattern: [{ pattern: 'absent', matches: 0 }],
      })
    );
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('0 match(es)');
  });

  it('keeps typed rejected outcomes non-successful', async () => {
    const result = await astSearchTool.handler(
      { pattern: '{', language: 'typescript' },
      client({
        outcome: 'rejected',
        provider: 'tree-sitter',
        code: 'AST_PATTERN_INVALID',
        reason: 'invalid',
      })
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { outcome: 'rejected', code: 'AST_PATTERN_INVALID' },
    });
  });
});
