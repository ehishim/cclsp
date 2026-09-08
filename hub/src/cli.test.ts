import { describe, expect, it } from 'bun:test';
import { normalizeToolJson, parse, runCli } from './cli.js';

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
        symbols: [
          {
            name: 'answer',
            range: { start: { line: 3, character: 1 }, end: { line: 5, character: 2 } },
          },
        ],
      },
    };
    expect(normalizeToolJson(envelope)).toMatchObject({
      outcome: 'ok',
      text: '/workspace/app/src/a.ts:4:2',
      shown: 1,
      total: 1,
      omitted: 0,
      ranges: [
        {
          path: '/workspace/app/src/a.ts',
          startLine: 4,
          startCharacter: 2,
          endLine: 6,
          endCharacter: 3,
        },
      ],
    });
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
    expect(output).toContain('--pattern P [--pattern P2 ...] --language L');
    expect(output).toContain('repeat --pattern: exact counts require a complete scan');
    expect(output).toContain('calls discover the owning language project');
    expect(output).toContain('a warm parent never overrides a nested project');
    expect(output).toContain('in-flight tools');
    expect(output).toContain('ast-search');
    expect(output).toContain('code_rewrite');
    expect(output).toContain('code-rewrite');
    expect(output).toContain('--dry-run=false --candidate-id ID');
    expect(output).toContain('use rename_symbol_strict for semantic symbol renames');
    expect(output).toContain(
      'find_definition         --file F (--symbol-name NAME [--symbol-kind K] | --line N --character C)'
    );
    expect(output).toContain(
      'find_references         --file F (--symbol-name NAME [--symbol-kind K] | --line N --character C) [--include-declaration]'
    );
    expect(output).toContain('--query Q | --line N --character C');
    expect(output).toContain('--resolve-limit N');
    expect(output).toContain('--synthetic-trigger');
    expect(output).toContain('Ambiguous and unknown queries return bounded candidates');
    expect(output).toContain('unconfirmed timeout is');
    expect(output).toContain('typed stale instead of false absence');
  });
});
