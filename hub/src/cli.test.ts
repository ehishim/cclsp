import { describe, expect, it } from 'bun:test';
import { parse, runCli } from './cli.js';

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
  });
});
