import { describe, expect, it } from 'bun:test';
import { normalizeToolJson, parse, runCli } from './cli.js';
import { markColdIndexResult } from './tool-result.js';

describe('cclsp-hub semantic ergonomics', () => {
  it('parses structural rewrite apply flags and alias without consuming values', () => {
    const parsed = parse([
      'code-rewrite',
      '--pattern',
      'foo($ARG)',
      '--replacement',
      'bar(0, $ARG)',
      '--language',
      'typescript',
      '--dry-run=false',
      '--candidate-id',
      `sha256:${'a'.repeat(64)}`,
    ]);
    expect(parsed.command).toBe('code-rewrite');
    expect(parsed.flags.get('dry-run')).toBe('false');
    expect(parsed.flags.get('candidate-id')).toBe(`sha256:${'a'.repeat(64)}`);
  });

  it('normalizes MCP tool envelopes for --json without transport fields', () => {
    const envelope = {
      content: [{ type: 'text', text: 'Readable result' }],
      structuredContent: { outcome: 'ok', provider: 'lsp', shown: 2, total: 3 },
      isError: false,
    };
    expect(normalizeToolJson(envelope)).toEqual({
      ...envelope.structuredContent,
      omitted: 1,
      text: 'Readable result',
    });
  });

  it('normalizes legacy text-only tools to a direct bounded result', () => {
    expect(normalizeToolJson({ content: [{ type: 'text', text: 'No symbols found' }] })).toEqual({
      outcome: 'ok',
      provider: 'none',
      shown: 0,
      total: 0,
      omitted: 0,
      text: 'No symbols found',
    });
  });

  it('normalizes nested MCP locations to direct one-based source ranges', () => {
    const envelope = {
      content: [{ type: 'text', text: '/workspace/app/src/a.ts:4:2' }],
      structuredContent: {
        outcome: 'ok',
        provider: 'lsp',
        file: '/workspace/app/src/a.ts',
        symbols: [{
          name: 'answer',
          range: { start: { line: 3, character: 1 }, end: { line: 5, character: 2 } },
        }],
      },
    };
    expect(normalizeToolJson(envelope)).toMatchObject({
      outcome: 'ok',
      text: '/workspace/app/src/a.ts:4:2',
      shown: 1,
      total: 1,
      omitted: 0,
      ranges: [{
        path: '/workspace/app/src/a.ts',
        startLine: 4,
        startCharacter: 2,
        endLine: 6,
        endCharacter: 3,
      }],
    });
  });

  it('marks cold workspace-index emptiness stale without delaying direct file tools', () => {
    const empty = { outcome: 'empty', provider: 'lsp', shown: 0, total: 0, omitted: 0, text: 'No symbols.' };
    expect(markColdIndexResult(empty, 'find_workspace_symbols', 100)).toMatchObject({
      outcome: 'stale', code: 'HUB_ROOT_INDEXING', recovery: expect.stringContaining('Retry'),
    });
    expect(markColdIndexResult(empty, 'find_workspace_symbols', 6_000)).toBe(empty);
    expect(markColdIndexResult(empty, 'get_document_symbols', 100)).toBe(empty);
  });

  it('marks a cold-index answer stale even when it found rows, because it may be partial', () => {
    const partial = {
      outcome: 'ok', provider: 'lsp', shown: 1, total: 1, omitted: 0, text: 'References (1/1)',
    };
    const marked = markColdIndexResult(partial, 'find_references', 100) as Record<string, unknown>;
    expect(marked).toMatchObject({ outcome: 'stale', code: 'HUB_ROOT_INDEXING', shown: 1, total: 1 });
    expect(marked.recovery).toContain('may be partial');
    expect(marked.text).toContain('References (1/1)');

    expect(markColdIndexResult(partial, 'find_references', 6_000)).toBe(partial);
    const failed = { outcome: 'unavailable', provider: 'none', text: 'server down' };
    expect(markColdIndexResult(failed, 'find_references', 100)).toBe(failed);
  });

  it('parses raw-mcp as a boolean without consuming the command', () => {
    const parsed = parse(['--raw-mcp', 'document-symbols', '--file', 'src/a.ts']);
    expect(parsed.command).toBe('document-symbols');
    expect(parsed.flags.get('raw-mcp')).toBe(true);
    expect(parsed.flags.get('file')).toBe('src/a.ts');
  });

  it('parses synthetic-trigger as a boolean without consuming the next token', () => {
    const parsed = parse(['get_completions', '--synthetic-trigger', '--query', 'Widget']);
    expect(parsed.command).toBe('get_completions');
    expect(parsed.flags.get('synthetic-trigger')).toBe(true);
    expect(parsed.flags.get('query')).toBe('Widget');

    const disabled = parse(['get_completions', '--synthetic-trigger=false']);
    expect(disabled.flags.get('synthetic-trigger')).toBe('false');
  });

  it('teaches query selectors, completion enrichment, and bounded recovery in top help', async () => {
    let output = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      await runCli([]);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(output).toContain('ast_search');
    expect(output).toContain('--pattern P --language L');
    expect(output).toContain('ast-search');
    expect(output).toContain('code_rewrite');
    expect(output).toContain('code-rewrite');
    expect(output).toContain('--dry-run=false --candidate-id ID');
    expect(output).toContain('use rename_symbol_strict for semantic symbol renames');
    expect(output).toContain('--query Q | --line N --character C');
    expect(output).toContain('--resolve-limit N');
    expect(output).toContain('--synthetic-trigger');
    expect(output).toContain('Ambiguous and unknown queries return bounded candidates');
    expect(output).toContain('returns stale with');
  });
});
