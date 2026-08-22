import { describe, expect, it, jest } from 'bun:test';
import type { LSPClient } from './lsp-client.js';
import { astSearchTool } from './tools/ast-search.js';

function client(result: Record<string, unknown>): LSPClient {
  return {
    astSearch: jest.fn().mockResolvedValue(result),
  } as unknown as LSPClient;
}

describe('ast_search tool', () => {
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
