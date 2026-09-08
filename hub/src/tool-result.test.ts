// Readiness precedence for index-dependent Hub answers.

import { describe, expect, it } from 'bun:test';
import { normalizeToolResult } from './tool-result.js';

describe('normalizeToolResult completeness', () => {
  it('keeps every normalized range above the former 1000-row projection cap', () => {
    const locations = Array.from({ length: 1500 }, (_, index) => ({
      uri: `file:///repo/file-${index}.ts`,
      range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
    }));
    const normalized = normalizeToolResult({
      content: [{ type: 'text', text: 'References (1500/1500)' }],
      structuredContent: { outcome: 'ok', provider: 'lsp', locations, shown: 1500, total: 1500, omitted: 0 },
    }) as Record<string, unknown>;

    expect((normalized.ranges as unknown[]).length).toBe(1500);
    expect(normalized.shown).toBe(1500);
    expect(normalized.total).toBe(1500);
    expect(normalized.omitted).toBe(0);
  });

  it('does not synthesize an exact total for a partial result', () => {
    const normalized = normalizeToolResult({
      content: [{ type: 'text', text: 'search incomplete' }],
      structuredContent: {
        outcome: 'partial',
        provider: 'tree-sitter',
        matches: [],
      },
      isError: true,
    }) as Record<string, unknown>;

    expect(normalized.shown).toBe(0);
    expect(normalized).not.toHaveProperty('total');
    expect(normalized).not.toHaveProperty('omitted');
    expect(normalized.isError).toBe(true);
  });
});
