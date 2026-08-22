import { describe, expect, it, jest } from 'bun:test';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PreparedRewrite, PreparedRewriteFile } from './ast/types.js';
import { type AtomicRewriteStage, applyAtomicRewrite } from './file-editor.js';

function hash(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

async function fixture(): Promise<{ root: string; prepared: PreparedRewrite }> {
  const root = await mkdtemp(join(tmpdir(), 'cclsp-transaction-'));
  const files: PreparedRewriteFile[] = [];
  for (const name of ['a.ts', 'b.ts']) {
    const absolutePath = join(root, name);
    const original = Buffer.from(`foo('${name}');\r\n`);
    const output = Buffer.from(`bar(0, '${name}');\r\n`);
    await writeFile(absolutePath, original);
    await chmod(absolutePath, 0o666);
    files.push({
      absolutePath,
      relativePath: name,
      mode: (await stat(absolutePath)).mode,
      original,
      output,
      originalSha256: hash(original),
      edits: [
        {
          startIndex: 0,
          endIndex: original.toString().indexOf(';'),
          before: original.toString().slice(0, original.toString().indexOf(';')),
          after: output.toString().slice(0, output.toString().indexOf(';')),
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 11 } },
        },
      ],
    });
  }
  return {
    root,
    prepared: {
      root,
      language: 'typescript',
      candidateId: `sha256:${'0'.repeat(64)}`,
      files,
      publicPreview: {
        outcome: 'ok',
        provider: 'tree-sitter',
        dryRun: true,
        language: 'typescript',
        candidateId: `sha256:${'0'.repeat(64)}`,
        changes: [],
        filesMatched: 2,
        filesChanged: 2,
        changesPlanned: 2,
        effectiveMaxChanges: 100,
        totalOriginalBytes: files.reduce((sum, file) => sum + file.original.length, 0),
        totalOutputBytes: files.reduce((sum, file) => sum + file.output.length, 0),
      },
    },
  };
}

async function noDebris(root: string): Promise<void> {
  expect((await readdir(root)).filter((name) => name.includes('cclsp-rewrite'))).toEqual([]);
}

describe('applyAtomicRewrite', () => {
  it('prepares every temp before the first rename and preserves exact bytes and modes', async () => {
    const { root, prepared } = await fixture();
    const stages: AtomicRewriteStage[] = [];
    try {
      const result = await applyAtomicRewrite(prepared, {
        synchronize: jest.fn().mockResolvedValue(undefined),
        invalidate: jest.fn().mockResolvedValue(undefined),
        inject: (stage) => {
          stages.push(stage);
        },
      });
      expect(result.success).toBe(true);
      expect(stages.lastIndexOf('before-temp-write')).toBeLessThan(stages.indexOf('before-rename'));
      for (const file of prepared.files) {
        expect(await readFile(file.absolutePath)).toEqual(file.output);
        expect((await stat(file.absolutePath)).mode & 0o777).toBe(0o666);
      }
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back exact bytes after a mid-commit failure and restores providers', async () => {
    const { root, prepared } = await fixture();
    const synchronized: string[][] = [];
    try {
      const result = await applyAtomicRewrite(prepared, {
        synchronize: async (files) => {
          synchronized.push(files.map((file) => file.content));
        },
        invalidate: jest.fn().mockResolvedValue(undefined),
        inject: (stage, _file, index) => {
          if (stage === 'before-rename' && index === 1) throw new Error('injected rename failure');
        },
      });
      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: true, disk: 'complete', providers: 'complete' },
      });
      for (const file of prepared.files) {
        expect(await readFile(file.absolutePath)).toEqual(file.original);
        expect((await stat(file.absolutePath)).mode & 0o777).toBe(0o666);
      }
      expect(synchronized.at(-1)).toEqual(
        prepared.files.map((file) => file.original.toString('utf8'))
      );
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('cleans all temps when preparation fails before mutation', async () => {
    const { root, prepared } = await fixture();
    const synchronize = jest.fn().mockResolvedValue(undefined);
    try {
      const result = await applyAtomicRewrite(prepared, {
        synchronize,
        invalidate: jest.fn().mockResolvedValue(undefined),
        inject: (stage, _file, index) => {
          if (stage === 'before-temp-write' && index === 1) throw new Error('temp write failure');
        },
      });
      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: false, disk: 'not-needed', providers: 'not-needed' },
      });
      for (const file of prepared.files)
        expect(await readFile(file.absolutePath)).toEqual(file.original);
      expect(synchronize).not.toHaveBeenCalled();
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back disk and providers when AST invalidation fails', async () => {
    const { root, prepared } = await fixture();
    let invalidations = 0;
    try {
      const result = await applyAtomicRewrite(prepared, {
        synchronize: jest.fn().mockResolvedValue(undefined),
        invalidate: async () => {
          invalidations++;
          if (invalidations === 1) throw new Error('forward invalidation failure');
        },
      });
      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: true, disk: 'complete', providers: 'complete' },
      });
      for (const file of prepared.files)
        expect(await readFile(file.absolutePath)).toEqual(file.original);
      expect(invalidations).toBe(2);
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('reports an injected rollback write failure without claiming complete recovery', async () => {
    const { root, prepared } = await fixture();
    try {
      const result = await applyAtomicRewrite(prepared, {
        synchronize: async () => {
          throw new Error('forward sync failure');
        },
        invalidate: jest.fn().mockResolvedValue(undefined),
        inject: (stage, file) => {
          if (stage === 'before-rollback-write' && file === prepared.files[0]?.absolutePath) {
            throw new Error('rollback write failure');
          }
        },
      });
      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: true, disk: 'failed', providers: 'failed' },
      });
      expect(result.rollback.failedFiles).toContain(prepared.files[0]?.absolutePath);
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('rolls back after partial provider synchronization and reports restoration failure', async () => {
    const { root, prepared } = await fixture();
    let syncCalls = 0;
    const invalidate = jest.fn().mockResolvedValue(undefined);
    try {
      const result = await applyAtomicRewrite(prepared, {
        synchronize: async () => {
          syncCalls++;
          if (syncCalls === 1) throw new Error('forward sync failure');
          throw new Error('restoration sync failure');
        },
        invalidate,
      });
      expect(result).toMatchObject({
        success: false,
        rollback: { attempted: true, disk: 'complete', providers: 'failed' },
      });
      expect(invalidate).toHaveBeenCalledTimes(1);
      for (const file of prepared.files)
        expect(await readFile(file.absolutePath)).toEqual(file.original);
      expect(result.rollback.failedFiles).toEqual(prepared.files.map((file) => file.absolutePath));
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses stale preflight without mutation or provider calls', async () => {
    const { root, prepared } = await fixture();
    const synchronize = jest.fn().mockResolvedValue(undefined);
    try {
      const staleFile = prepared.files[1];
      const untouchedFile = prepared.files[0];
      if (!staleFile || !untouchedFile) throw new Error('fixture files missing');
      await writeFile(staleFile.absolutePath, 'external same-ish edit');
      const result = await applyAtomicRewrite(prepared, {
        synchronize,
        invalidate: jest.fn().mockResolvedValue(undefined),
      });
      expect(result).toMatchObject({
        success: false,
        code: 'AST_REWRITE_STALE',
        rollback: { attempted: false, disk: 'not-needed', providers: 'not-needed' },
      });
      expect(await readFile(untouchedFile.absolutePath)).toEqual(untouchedFile.original);
      expect(synchronize).not.toHaveBeenCalled();
      await noDebris(root);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
