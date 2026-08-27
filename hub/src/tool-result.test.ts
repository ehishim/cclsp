// Readiness precedence for index-dependent Hub answers.

import { describe, expect, it } from 'bun:test';
import { markColdIndexResult } from './tool-result.js';

describe('markColdIndexResult readiness precedence', () => {
  it('a REPORTED readiness fact overrules the wall-clock window', () => {
    // The window is a guess at a thing the tool can now observe. A few fixed
    // seconds cannot describe a real project-graph load, so an answer served
    // after the window closed still read as complete.
    const late = 60_000;
    const unconfirmed = markColdIndexResult(
      { outcome: 'empty', text: 'Workspace symbols (0/0)', readinessConfirmed: false },
      'find_workspace_symbols',
      late,
    ) as Record<string, unknown>;

    expect(unconfirmed.outcome).toBe('stale');
    expect(unconfirmed.code).toBe('HUB_ROOT_INDEXING');
  });

  it('a confirmed fact keeps the answer as-is even inside the cold window', () => {
    const confirmed = markColdIndexResult(
      { outcome: 'empty', text: 'Workspace symbols (0/0)', readinessConfirmed: true },
      'find_workspace_symbols',
      0,
    ) as Record<string, unknown>;

    expect(confirmed.outcome).toBe('empty');
  });

  it('still falls back to the window for a tool that reports nothing', () => {
    const cold = markColdIndexResult(
      { outcome: 'empty', text: 'Workspace symbols (0/0)' },
      'find_workspace_symbols',
      0,
    ) as Record<string, unknown>;
    const warm = markColdIndexResult(
      { outcome: 'empty', text: 'Workspace symbols (0/0)' },
      'find_workspace_symbols',
      60_000,
    ) as Record<string, unknown>;

    expect(cold.outcome).toBe('stale');
    expect(warm.outcome).toBe('empty');
  });
});
