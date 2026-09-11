import { describe, expect, it } from 'bun:test';
import { createSourcePreview, previewSpan, renderLocationRow } from './tools/source-preview.js';

function countingReader(body: string) {
  const reads: string[] = [];
  return {
    reads,
    read: (file: string) => {
      reads.push(file);
      return body;
    },
  };
}

const FILE = '/workspace/src/sample.ts';
const BODY = ['const first = 1;', '', 'export function target() {', '  return 2;', '}', ''].join(
  '\n'
);

describe('source window owner', () => {
  it('reads each file once however many rows ask for it', () => {
    // The claim this proves is the per-call cost: a hundred references commonly
    // land in a handful of files, and re-reading one per row would make the window
    // more expensive than the read it replaces.
    const reader = countingReader(BODY);
    const preview = createSourcePreview(true, reader.read);
    for (let row = 0; row < 100; row += 1) previewSpan(preview, FILE, 2);
    expect(reader.reads).toEqual([FILE]);
  });

  it('caches an unreadable file too, so a broken path is not retried per row', () => {
    const reads: string[] = [];
    const preview = createSourcePreview(true, (file) => {
      reads.push(file);
      throw new Error('ENOENT');
    });
    // The row itself must survive: only its window is missing.
    expect(previewSpan(preview, FILE, 2)).toEqual([]);
    expect(previewSpan(preview, FILE, 3)).toEqual([]);
    expect(renderLocationRow(preview, { file: FILE, zeroBasedLine: 2, zeroBasedCharacter: 0 })).toBe(
      `${FILE}:3:1`
    );
    expect(reads).toEqual([FILE]);
  });

  it('renders the grep convention contiguously, marking only the matched span', () => {
    const preview = createSourcePreview(1, countingReader(BODY).read);
    expect(previewSpan(preview, FILE, 2, 4)).toEqual([
      '  2- ',
      '  3: export function target() {',
      '  4:   return 2;',
      '  5: }',
      '  6- ',
    ]);
  });

  it('refuses an invalid width instead of returning a silently different window', () => {
    for (const invalid of [-1, 1.5, 21, Number.NaN]) {
      expect(() => createSourcePreview(invalid as number)).toThrow();
    }
    // `false` and `0` are the two spellings of "positions only", not failures.
    expect(createSourcePreview(false)).toBeNull();
    expect(createSourcePreview(0)).toBeNull();
    // Omission and `true` both take the default window.
    const byDefault = createSourcePreview(undefined);
    const byTrue = createSourcePreview(true);
    expect(byDefault?.context).toBeGreaterThan(0);
    expect(byDefault?.context).toBe(byTrue?.context as number);
  });

  it('clips a long line instead of letting one row carry the whole answer', () => {
    const long = `const x = "${'y'.repeat(500)}";`;
    const preview = createSourcePreview(0 + 1, countingReader(long).read);
    const [row] = previewSpan(preview, FILE, 0);
    expect(row?.length).toBeLessThan(230);
    expect(row?.endsWith('…')).toBe(true);
  });
});
