import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Tree as TsTree } from 'web-tree-sitter';
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
  it('scopes discovery before the project cap and sees later subtree additions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-scope-'));
    const index = await WorkspaceIndex.create(root);
    try {
      await mkdir(join(root, 'selected'));
      await mkdir(join(root, 'unrelated'));
      await writeInBatches(
        join(root, 'unrelated'),
        Array.from({ length: AST_MAX_FILES + 1 }, (_, i) => `${i}.ts`)
      );
      await writeFile(join(root, 'selected', 'a.ts'), 'export const a = 1;');
      const first = await index.ensureScope(join(root, 'selected'));
      expect(first.capped).toBe(false);
      expect(first.files.map((file) => file.relativePath)).toEqual(['selected/a.ts']);
      expect(
        [...first.directories.keys()].every((path) => path.startsWith(join(root, 'selected')))
      ).toBe(true);
      await writeFile(join(root, 'selected', 'b.ts'), 'export const b = 2;');
      const next = await index.ensureScope(join(root, 'selected'));
      expect(next.files.map((file) => file.relativePath)).toEqual([
        'selected/a.ts',
        'selected/b.ts',
      ]);
    } finally {
      index.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });
  it('fails closed for ignored, symlinked, escaped, and language-mismatched rewrite targets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-safe-'));
    const outside = await mkdtemp(join(tmpdir(), 'cclsp-index-safe-outside-'));
    const index = await WorkspaceIndex.create(root);
    try {
      await mkdir(join(root, 'dist'));
      await writeFile(join(root, 'dist', 'ignored.ts'), 'const x = 1;\n');
      await writeFile(join(root, 'safe.ts'), 'const x = 1;\n');
      await writeFile(join(root, 'wrong.py'), 'x = 1\n');
      await writeFile(join(outside, 'escaped.ts'), 'const x = 1;\n');
      await symlink(join(outside, 'escaped.ts'), join(root, 'linked.ts'));

      await expect(index.resolveRewritePath('dist/ignored.ts')).rejects.toThrow(
        'AST_REWRITE_TARGET_UNSAFE'
      );
      await expect(index.resolveRewritePath('linked.ts')).rejects.toThrow(
        'AST_REWRITE_TARGET_UNSAFE'
      );
      await expect(index.resolveRewritePath('../escaped.ts')).rejects.toThrow('AST_PATH_ESCAPED');
      const wrong = await index.resolveRewritePath('wrong.py');
      await expect(index.getRewriteFiles(wrong, 'typescript')).rejects.toThrow('AST_PATH_INVALID');
      expect(await index.resolveRewritePath('safe.ts')).toBe(join(root, 'safe.ts'));
    } finally {
      index.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });
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
        } as unknown as TsTree;
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

  it('keeps a recently accessed tree and evicts the least recently used tree', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-lru-'));
    const deleted: number[] = [];
    const index = await WorkspaceIndex.create(root);
    try {
      for (let entry = 0; entry < 129; entry++) {
        if (entry === 128)
          expect(index.getCachedTree(join(root, '0.ts'), 'typescript', '0')).toBeDefined();
        index.setCachedTree(
          {
            path: join(root, `${entry}.ts`),
            contentHash: String(entry),
            mtimeMs: entry,
            bytes: 1,
            source: '',
            tree: { delete: () => deleted.push(entry) } as unknown as TsTree,
          },
          'typescript'
        );
      }
      expect(deleted).toEqual([1]);
      expect(index.getCachedTree(join(root, '0.ts'), 'typescript', '0')).toBeDefined();
      expect(index.getCachedTree(join(root, '1.ts'), 'typescript', '1')).toBeUndefined();
    } finally {
      index.dispose();
      await rm(root, { recursive: true, force: true });
    }
    expect(deleted.length).toBe(129);
    expect(new Set(deleted).size).toBe(129);
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
            tree: { delete: () => deleted++ } as unknown as TsTree,
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

  it('indexes .css and leaves the preprocessor dialects unmapped', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cclsp-index-css-'));
    let index: WorkspaceIndex | undefined;
    try {
      await writeFile(join(root, 'panel.module.css'), '.panel { color: red; }\n');
      // No grammar asset ships for these dialects, and parsing them as CSS would
      // manufacture failures for a syntax nobody claimed to support.
      await writeFile(join(root, 'legacy.scss'), '$c: red;\n.panel { color: $c; }\n');
      await writeFile(join(root, 'legacy.less'), '@c: red;\n.panel { color: @c; }\n');

      index = await WorkspaceIndex.create(root);
      const snapshot = await index.ensure();
      expect(snapshot.files.map((file) => [file.relativePath, file.language]).sort()).toEqual([
        ['panel.module.css', 'css'],
      ]);
    } finally {
      index?.dispose();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('coalesces a complete gitignore-aware index beyond 5,000 files and refreshes deletion', async () => {
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
      expect(first.capped).toBe(false);
      expect(first.files).toHaveLength(AST_MAX_FILES + 1);
      expect(first.files[0]?.relativePath).toBe('f00000.ts');
      expect(first.files.at(-1)?.relativePath).toBe('f05000.ts');
      expect(first.oversizedFiles.map((file) => file.relativePath)).toEqual(['_oversized.ts']);
      expect(first.files.some((file) => file.relativePath.includes('ignored'))).toBe(false);
      expect(first.files.some((file) => file.relativePath === '_escape.ts')).toBe(false);

      await unlink(join(root, 'f00000.ts'));
      const refreshed = await index.ensure();
      expect(refreshed.generation).toBeGreaterThan(first.generation);
      expect(refreshed.capped).toBe(false);
      expect(refreshed.files).toHaveLength(AST_MAX_FILES);
      expect(refreshed.files[0]?.relativePath).toBe('f00001.ts');
      expect(refreshed.files.at(-1)?.relativePath).toBe('f05000.ts');
    } finally {
      index?.dispose();
      await rm(root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  }, 30_000);
});
