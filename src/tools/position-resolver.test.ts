import { describe, expect, it, jest } from 'bun:test';
import type { LSPClient } from '../lsp-client.js';
import { positionResolutionResult, resolveToolPosition } from './position-resolver.js';

function client(symbols: unknown[]): LSPClient {
  return {
    getDocumentSymbols: jest.fn().mockResolvedValue(symbols),
    symbolKindToString: (kind: number) =>
      ({ 5: 'class', 6: 'method', 12: 'function' })[kind] ?? 'unknown',
  } as unknown as LSPClient;
}

const symbols = [
  {
    name: 'Widget',
    kind: 5,
    range: { start: { line: 0, character: 0 }, end: { line: 8, character: 1 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 12 } },
    children: [
      {
        name: 'render',
        kind: 6,
        range: { start: { line: 1, character: 2 }, end: { line: 2, character: 3 } },
        selectionRange: { start: { line: 1, character: 2 }, end: { line: 1, character: 8 } },
      },
    ],
  },
  {
    name: 'renderHelper',
    kind: 12,
    range: { start: { line: 10, character: 0 }, end: { line: 11, character: 1 } },
    selectionRange: { start: { line: 10, character: 9 }, end: { line: 10, character: 21 } },
  },
];

describe('resolveToolPosition', () => {
  it('preserves 1-indexed coordinate grammar', async () => {
    await expect(
      resolveToolPosition('/fixture.ts', { line: 4, character: 7 }, client([]))
    ).resolves.toEqual({ outcome: 'resolved', position: { line: 3, character: 6 } });
  });

  it('resolves qualified, case-insensitive, and unique substring queries', async () => {
    expect(
      await resolveToolPosition('/fixture.ts', { query: 'Widget.render' }, client(symbols))
    ).toMatchObject({
      outcome: 'resolved',
      query: 'Widget.render',
      position: { line: 1, character: 2 },
      candidate: { qualifiedName: 'Widget.render' },
    });
    expect(
      await resolveToolPosition('/fixture.ts', { query: 'WIDGET' }, client(symbols))
    ).toMatchObject({
      outcome: 'resolved',
      candidate: { name: 'Widget' },
    });
    expect(
      await resolveToolPosition('/fixture.ts', { query: 'helper' }, client(symbols))
    ).toMatchObject({
      outcome: 'resolved',
      candidate: { name: 'renderHelper' },
    });
  });

  it('returns all matches from the first ambiguous tier instead of guessing', async () => {
    const duplicate = [
      ...symbols,
      {
        name: 'Other',
        kind: 5,
        range: { start: { line: 20, character: 0 }, end: { line: 25, character: 1 } },
        selectionRange: { start: { line: 20, character: 6 }, end: { line: 20, character: 11 } },
        children: [
          {
            name: 'render',
            kind: 6,
            range: { start: { line: 21, character: 2 }, end: { line: 22, character: 3 } },
            selectionRange: { start: { line: 21, character: 2 }, end: { line: 21, character: 8 } },
          },
        ],
      },
    ];
    const result = await resolveToolPosition('/fixture.ts', { query: 'render' }, client(duplicate));
    expect(result).toMatchObject({ outcome: 'ambiguous' });
    if (result.outcome !== 'ambiguous') throw new Error('expected ambiguity');
    expect(result.candidates.map((candidate) => candidate.qualifiedName)).toEqual([
      'Widget.render',
      'Other.render',
    ]);
    expect(positionResolutionResult(result, '/fixture.ts')).toMatchObject({
      isError: true,
      structuredContent: { code: 'LSP_SYMBOL_AMBIGUOUS' },
    });
  });

  it('returns bounded available symbols for unknown queries', async () => {
    const many = Array.from({ length: 25 }, (_, index) => ({
      name: `symbol${index}`,
      kind: 12,
      location: {
        uri: 'file:///fixture.ts',
        range: { start: { line: index, character: 0 }, end: { line: index, character: 1 } },
      },
    }));
    const result = await resolveToolPosition('/fixture.ts', { query: 'missing' }, client(many));
    expect(result).toMatchObject({ outcome: 'not_found' });
    if (result.outcome !== 'not_found') throw new Error('expected not found');
    expect(result.candidates).toHaveLength(20);
  });

  it('rejects mixed and partial selectors without symbol lookup', async () => {
    const mock = client(symbols);
    await expect(
      resolveToolPosition('/fixture.ts', { query: 'Widget', line: 1, character: 1 }, mock)
    ).resolves.toMatchObject({ outcome: 'invalid' });
    await expect(resolveToolPosition('/fixture.ts', { line: 1 }, mock)).resolves.toMatchObject({
      outcome: 'invalid',
    });
    expect(mock.getDocumentSymbols).not.toHaveBeenCalled();
  });
});
