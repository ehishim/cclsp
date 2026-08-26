import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spoolFilePath, spoolFullResult } from './result-spool.js';

const previous = process.env.CCLSP_RESULT_DIR;

afterEach(() => {
  if (previous === undefined) delete process.env.CCLSP_RESULT_DIR;
  else process.env.CCLSP_RESULT_DIR = previous;
});

describe('result spool ownership', () => {
  it('keeps the spool private and each answer unreadable to other users', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cclsp-spool-')), 'results');
    process.env.CCLSP_RESULT_DIR = dir;
    const path = spoolFullResult('get_document_symbols', { symbols: [1, 2, 3] });
    expect(path).not.toBeNull();
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(path as string).mode & 0o777).toBe(0o600);
    rmSync(dir, { recursive: true, force: true });
  });

  it('tightens a spool directory an older build left world-readable', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'cclsp-spool-legacy-')), 'results');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    expect(statSync(dir).mode & 0o777).toBe(0o755);

    process.env.CCLSP_RESULT_DIR = dir;
    spoolFilePath('find_references', 'stamp');
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    rmSync(dir, { recursive: true, force: true });
  });
});
