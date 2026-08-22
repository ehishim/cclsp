import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Parser from 'web-tree-sitter';
import { AST_MAX_FILES, AST_MAX_FILE_BYTES } from './types.js';
import { WorkspaceIndex } from './workspace-index.js';

async function writeInBatches(root: string, paths: string[]): Promise<void> {
  for (let offset = 0; offset < paths.length; offset += 250) {
    await Promise.all(
      paths.slice(offset, offset + 250).map((path) => writeFile(join(root, path), 'const x = 1;\n'))
    );
  }
}

describe('WorkspaceIndex maximum representative scope', () => {
  it('deletes every parsed tree exactly once across cache eviction and disposal', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-cache-'));
    const deleted = Array.from({ length: 129 }, () => 0);
    const index = await WorkspaceIndex.create(root);
    try {
      for (let entry = 0; entry < deleted.length; entry++) {
        const tree = {
          delete: () => {
            deleted[entry] = (deleted[entry] ?? 0) + 1;
          },
        } as unknown as Parser.Tree;
        index.setCachedTree(
          {
            path: join(root, `${entry}.ts`),
            contentHash: String(entry),
            mtimeMs: entry,
            bytes: 1,
            source: '',
            tree,
          },
          'typescript'
        );
      }
      expect(deleted[0]).toBe(1);
      expect(deleted.slice(1).every((count) => count === 0)).toBe(true);
    } finally {
      index.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(deleted.every((count) => count === 1)).toBe(true);
  });

  it('evicts trees when cached source bytes exceed 64 MiB', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-cache-bytes-'));
    let deleted = 0;
    const index = await WorkspaceIndex.create(root);
    try {
      for (let entry = 0; entry < 65; entry++) {
        index.setCachedTree(
          {
            path: join(root, `${entry}.ts`),
            contentHash: String(entry),
            mtimeMs: entry,
            bytes: 1024 * 1024,
            source: '',
            tree: { delete: () => deleted++ } as unknown as Parser.Tree,
          },
          'typescript'
        );
      }
      expect(deleted).toBe(1);
    } finally {
      index.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(deleted).toBe(65);
  });

  it('coalesces a deterministic gitignore-aware 5,000-file index and rebuilds its capped prefix', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-max-'));
    const outside = await mkdtemp(join(tmpdir(), 'cclsp-index-outside-'));
    let index: WorkspaceIndex | undefined;
    try {
      await writeFile(join(root, '.gitignore'), 'ignored/\n');
      await mkdir(join(root, 'ignored'));
      await writeFile(join(root, 'ignored', 'ignored.ts'), 'const ignored = true;\n');
      await writeFile(join(root, '_oversized.ts'), 'x'.repeat(AST_MAX_FILE_BYTES + 1));
      await writeFile(join(outside, 'escaped.ts'), 'const escaped = true;\n');
      await symlink(join(outside, 'escaped.ts'), join(root, '_escape.ts'));

      const files = Array.from(
        { length: AST_MAX_FILES + 1 },
        (_, index) => `f${String(index).padStart(5, '0')}.ts`
      );
      await writeInBatches(root, files);

      index = await WorkspaceIndex.create(root);
      const [first, concurrent] = await Promise.all([index.ensure(), index.ensure()]);
      expect(concurrent).toBe(first);
      expect(first.capped).toBe(true);
      expect(first.files).toHaveLength(AST_MAX_FILES - 1);
      expect(first.files[0]?.relativePath).toBe('f00000.ts');
      expect(first.files.at(-1)?.relativePath).toBe('f04998.ts');
      expect(first.oversizedFiles.map((file) => file.relativePath)).toEqual(['_oversized.ts']);
      expect(first.files.some((file) => file.relativePath.includes('ignored'))).toBe(false);
      expect(first.files.some((file) => file.relativePath === '_escape.ts')).toBe(false);

      await unlink(join(root, 'f00000.ts'));
      const refreshed = await index.ensure();
      expect(refreshed.generation).toBeGreaterThan(first.generation);
      expect(refreshed.capped).toBe(true);
      expect(refreshed.files).toHaveLength(AST_MAX_FILES - 1);
      expect(refreshed.files[0]?.relativePath).toBe('f00001.ts');
      expect(refreshed.files.at(-1)?.relativePath).toBe('f04999.ts');
    } finally {
      index?.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
