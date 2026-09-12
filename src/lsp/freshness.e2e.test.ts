// Opt-in real-provider regression scenarios; the caller selects an isolated TypeScript server.
import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LSPClient } from '../lsp-client.js';
import { renameFileTool } from '../tools/refactoring.js';

const require = createRequire(import.meta.url);
const server = process.env.CCLSP_TEST_TS_SERVER;
const suite = server ? describe : describe.skip;

async function fixture<T>(
  files: Record<string, string>,
  action: (root: string, client: LSPClient) => Promise<T>
): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'cclsp-real-freshness-'));
  let client: LSPClient | undefined;
  try {
    await symlink(
      dirname(dirname(require.resolve('typescript/package.json'))),
      join(root, 'node_modules')
    );
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          strict: true,
          types: [],
          skipLibCheck: true,
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
        },
        include: ['*.ts'],
      })
    );
    for (const [name, body] of Object.entries(files)) await writeFile(join(root, name), body);
    const config = join(root, 'cclsp.json');
    await writeFile(
      config,
      JSON.stringify({
        servers: [{ extensions: ['ts'], command: [server, '--stdio'], rootDir: root }],
      })
    );
    client = new LSPClient(config, root);
    return await action(root, client);
  } finally {
    await client?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

suite('real TypeScript freshness and refactoring', () => {
  it('answers imported-owner edits immediately in single and batch queries, including inverse and deletion', async () => {
    await fixture(
      {
        'owner.ts': 'export interface Value { old: string }\n',
        'consumer.ts':
          'import type { Value } from "./owner.js"; export const read = (v: Value) => v.old;\n',
      },
      async (root, client) => {
        const owner = join(root, 'owner.ts');
        const consumer = join(root, 'consumer.ts');
        await client.getDiagnostics(owner);
        expect(await client.getDiagnostics(consumer)).toEqual([]);
        await writeFile(owner, 'export interface Value { next: string }\n');
        expect((await client.getDiagnostics(consumer)).some((row) => row.code === 2339)).toBe(true);
        expect(
          (await client.getDiagnosticsBatch([consumer]))[0]?.diagnostics.some(
            (row) => row.code === 2339
          )
        ).toBe(true);
        await writeFile(owner, 'export interface Value { old: string }\n');
        expect(await client.getDiagnostics(consumer)).toEqual([]);
        await rm(owner);
        expect((await client.getDiagnostics(consumer)).some((row) => row.code === 2307)).toBe(true);
      }
    );
  }, 30000);

  it('returns all 200 errors through bounded mixed single/batch calls', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`f${i}.ts`, `export const v${i}: string = 1;\n`])
    );
    await fixture(files, async (root, client) => {
      const paths = Object.keys(files).map((name) => join(root, name));
      const first = await client.getDiagnosticsBatch(paths);
      expect(first).toHaveLength(200);
      expect(
        first.every(
          (row) => row.status === 'current' && row.diagnostics.some((d) => d.code === 2322)
        )
      ).toBe(true);
      const elapsed: number[] = [];
      for (let sample = 0; sample < 3; sample++) {
        const start = performance.now();
        const rows = await client.getDiagnosticsBatch(paths);
        elapsed.push(performance.now() - start);
        expect(rows.filter((row) => row.status === 'current')).toHaveLength(200);
      }
      expect(elapsed.sort((a, b) => a - b)[1]).toBeLessThan(1500);
      const mixed = await Promise.all([
        client.getDiagnosticsBatch(paths),
        client.getDiagnosticsBatch(paths),
        ...paths.slice(0, 10).map((path) => client.getDiagnostics(path)),
      ]);
      expect(mixed[0]).toHaveLength(200);
      expect(mixed[1]).toHaveLength(200);
      expect(mixed.slice(2).every((rows) => rows.length === 1)).toBe(true);
    });
  }, 30000);

  it('renames a file used by 250 importers with 12 and 100 open buffers, then restores it', async () => {
    const files: Record<string, string> = { 'owner.ts': 'export const value = 1;\n' };
    for (let i = 0; i < 250; i++)
      files[`f${i}.ts`] = 'import { value } from "./owner.js"; export const result = value;\n';
    for (const openCount of [12, 100]) {
      await fixture(files, async (root, client) => {
        const importers = Array.from({ length: 250 }, (_, i) => join(root, `f${i}.ts`));
        for (const path of importers.slice(0, openCount)) await client.getDocumentSymbols(path);
        const start = performance.now();
        const firstMove = { old_path: join(root, 'owner.ts'), new_path: join(root, 'renamed.ts') };
        const firstPreview = await renameFileTool.handler(firstMove, client);
        const result = await renameFileTool.handler(
          {
            ...firstMove,
            dry_run: false,
            candidate_id: firstPreview.structuredContent?.candidateId,
          },
          client
        );
        expect(result.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
        expect(performance.now() - start).toBeLessThan(5000);
        for (const path of importers)
          expect(await readFile(path, 'utf8')).toContain('./renamed.js');
        const firstImporter = importers[0];
        if (!firstImporter) throw new Error('missing importer fixture');
        expect(await client.getDiagnostics(firstImporter)).toEqual([]);
        const inverseMove = {
          old_path: join(root, 'renamed.ts'),
          new_path: join(root, 'owner.ts'),
        };
        const inversePreview = await renameFileTool.handler(inverseMove, client);
        const inverse = await renameFileTool.handler(
          {
            ...inverseMove,
            dry_run: false,
            candidate_id: inversePreview.structuredContent?.candidateId,
          },
          client
        );
        expect(inverse.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
        for (const path of importers) expect(await readFile(path, 'utf8')).toContain('./owner.js');
      });
    }
  }, 30000);
});
