// Readiness precedence for index-dependent Hub answers.

import { describe, expect, it } from 'bun:test';
import { normalizeToolResult } from './tool-result.js';

describe('normalizeToolResult completeness', () => {
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
