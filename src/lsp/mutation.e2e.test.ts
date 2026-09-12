// Opt-in real-provider proof for the complete TypeScript and PHP mutation path.
import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LSPClient } from '../lsp-client.js';
import { codeRewriteTool } from '../tools/code-rewrite.js';
import { getCodeActionsTool, getCompletionsTool } from '../tools/language-features.js';
import { renameFileTool, renameSymbolStrictTool } from '../tools/refactoring.js';

const require = createRequire(import.meta.url);
const tsServer = process.env.CCLSP_TEST_TS_SERVER;
const phpServer = process.env.CCLSP_TEST_PHP_SERVER;
const suite = tsServer && phpServer ? describe : describe.skip;

async function fixture<T>(action: (root: string, client: LSPClient) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'cclsp-real-mutation-'));
  let client: LSPClient | undefined;
  try {
    await symlink(
      dirname(dirname(require.resolve('typescript/package.json'))),
      join(root, 'node_modules')
    );
    await mkdir(join(root, 'src'));
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
        include: ['src/*.ts'],
      })
    );
    await writeFile(
      join(root, 'composer.json'),
      JSON.stringify({
        name: 'cclsp/mutation-fixture',
        autoload: { 'psr-4': { 'Fixture\\': 'src/' } },
      })
    );
    await writeFile(
      join(root, 'src/math.ts'),
      'export function doubleValue(value: number): number { return value * 2; }\n'
    );
    await writeFile(
      join(root, 'src/app.ts'),
      "import { doubleValue } from './math.js';\nexport const result = doubleValue(21);\n"
    );
    await writeFile(
      join(root, 'src/Math.php'),
      '<?php\nnamespace Fixture;\nfunction doubleValue(int $value): int { return $value * 2; }\n'
    );
    await writeFile(
      join(root, 'src/App.php'),
      "<?php\nnamespace Fixture;\nrequire_once __DIR__ . '/Math.php';\n$result = doubleValue(21);\n"
    );
    await writeFile(
      join(root, 'src/alpha.mjs'),
      "import { beta } from './beta.mjs';\nexport const alpha = beta;\n"
    );
    await writeFile(
      join(root, 'src/beta.mjs'),
      "import { alpha } from './alpha.mjs';\nexport const beta = alpha;\n"
    );
    const config = join(root, 'cclsp.json');
    await writeFile(
      config,
      JSON.stringify({
        servers: [
          { extensions: ['ts', 'mjs'], command: [tsServer, '--stdio'], rootDir: root },
          { extensions: ['php'], command: [phpServer, '--stdio'], rootDir: root },
        ],
      })
    );
    client = new LSPClient(config, root);
    return await action(root, client);
  } finally {
    await client?.dispose();
    await rm(root, { recursive: true, force: true });
  }
}

suite('real TypeScript and PHP mutations', () => {
  for (const row of [
    {
      language: 'typescript',
      file: 'src/app.ts',
      pattern: 'doubleValue($ARG)',
      replacement: 'Number(doubleValue($ARG))',
      changed: 'Number(doubleValue(21))',
    },
    {
      language: 'php',
      file: 'src/App.php',
      pattern: 'doubleValue($ARG)',
      replacement: 'intval(doubleValue($ARG))',
      changed: 'intval(doubleValue(21))',
    },
  ] as const) {
    it(`${row.language} structural rewrite previews, applies, and refuses stale candidates`, async () => {
      await fixture(async (root, client) => {
        const file = join(root, row.file);
        const before = await readFile(file, 'utf8');
        const input = {
          path: file,
          language: row.language,
          pattern: row.pattern,
          replacement: row.replacement,
        };
        const preview = await codeRewriteTool.handler(input, client);
        expect(preview.structuredContent).toMatchObject({
          outcome: 'ok',
          dryRun: true,
          changesPlanned: 1,
        });
        expect(await readFile(file, 'utf8')).toBe(before);
        const candidate = preview.structuredContent?.candidateId as string;
        const applied = await codeRewriteTool.handler(
          { ...input, dry_run: false, candidate_id: candidate },
          client
        );
        expect(applied.structuredContent).toMatchObject({
          outcome: 'ok',
          dryRun: false,
          changesApplied: 1,
        });
        expect(await readFile(file, 'utf8')).toContain(row.changed);
        const stale = await codeRewriteTool.handler(
          { ...input, dry_run: false, candidate_id: candidate },
          client
        );
        expect(stale).toMatchObject({
          isError: true,
          structuredContent: { code: 'AST_REWRITE_STALE' },
        });
        expect((await client.getDiagnosticsReport(file)).freshness.status).toBe('current');
      });
    }, 45_000);
  }

  for (const row of [
    { language: 'TypeScript', owner: 'src/math.ts', consumer: 'src/app.ts' },
    { language: 'PHP', owner: 'src/Math.php', consumer: 'src/App.php' },
  ] as const) {
    it(`${row.language} semantic rename previews and applies exactly one candidate`, async () => {
      await fixture(async (root, client) => {
        const owner = join(root, row.owner);
        const consumer = join(root, row.consumer);
        const beforeOwner = await readFile(owner, 'utf8');
        const beforeConsumer = await readFile(consumer, 'utf8');
        const preview = await renameSymbolStrictTool.handler(
          {
            file_path: owner,
            query: 'doubleValue',
            new_name: 'twiceValue',
            dry_run: true,
          },
          client
        );
        expect(preview.structuredContent).toMatchObject({
          outcome: 'ok',
          applied: false,
          prepared: true,
        });
        const candidate = preview.structuredContent?.candidateId as string;
        expect(candidate).toMatch(/^sha256:[0-9a-f]{64}$/);
        expect(preview.content[0]?.text).toContain(`Candidate ID: ${candidate}`);
        expect(preview.content[0]?.text).toContain(
          row.language === 'TypeScript'
            ? 'export function doubleValue'
            : 'function doubleValue(int $value)'
        );
        expect(await readFile(owner, 'utf8')).toBe(beforeOwner);
        expect(await readFile(consumer, 'utf8')).toBe(beforeConsumer);
        const missingCandidate = await renameSymbolStrictTool.handler(
          {
            file_path: owner,
            query: 'doubleValue',
            new_name: 'twiceValue',
            dry_run: false,
          },
          client
        );
        expect(missingCandidate).toMatchObject({
          isError: true,
          structuredContent: { code: 'LSP_RENAME_PREVIEW_REQUIRED' },
        });
        const staleCandidate = await renameSymbolStrictTool.handler(
          {
            file_path: owner,
            query: 'doubleValue',
            new_name: 'twiceValue',
            dry_run: false,
            candidate_id: `sha256:${'0'.repeat(64)}`,
          },
          client
        );
        expect(staleCandidate).toMatchObject({
          isError: true,
          structuredContent: { code: 'LSP_RENAME_STALE', applied: false },
        });
        expect(await readFile(owner, 'utf8')).toBe(beforeOwner);
        expect(await readFile(consumer, 'utf8')).toBe(beforeConsumer);
        const applied = await renameSymbolStrictTool.handler(
          {
            file_path: owner,
            query: 'doubleValue',
            new_name: 'twiceValue',
            dry_run: false,
            candidate_id: candidate,
          },
          client
        );
        expect(applied.structuredContent).toMatchObject({
          outcome: 'ok',
          applied: true,
          candidateId: candidate,
        });
        expect(await readFile(owner, 'utf8')).toContain('twiceValue');
        expect(await readFile(consumer, 'utf8')).toContain('twiceValue');
        const unknown = await renameSymbolStrictTool.handler(
          {
            file_path: owner,
            query: 'doesNotExist',
            new_name: 'never',
            dry_run: true,
          },
          client
        );
        expect(unknown.isError).toBe(true);
        expect(await readFile(owner, 'utf8')).toContain('twiceValue');
        expect((await client.getDiagnosticsReport(consumer)).freshness.status).toBe('current');
      });
    }, 60_000);
  }

  it('applies Intelephense class rename with provider-owned file move and code edits', async () => {
    await fixture(async (root, client) => {
      const owner = join(root, 'src/Widget.php');
      const consumer = join(root, 'src/WidgetConsumer.php');
      await writeFile(owner, '<?php\nnamespace Fixture;\nclass Widget {}\n');
      await writeFile(consumer, '<?php\nnamespace Fixture;\n$widget = new Widget();\n');

      const preview = await renameSymbolStrictTool.handler(
        { file_path: owner, query: 'Widget', new_name: 'RenamedWidget', dry_run: true },
        client
      );
      expect(preview.structuredContent).toMatchObject({
        outcome: 'ok',
        applied: false,
        resourceMoves: [{ oldPath: owner, newPath: join(root, 'src/RenamedWidget.php') }],
      });
      expect(await Bun.file(owner).exists()).toBe(true);
      const candidate = preview.structuredContent?.candidateId as string;
      const applied = await renameSymbolStrictTool.handler(
        {
          file_path: owner,
          query: 'Widget',
          new_name: 'RenamedWidget',
          dry_run: false,
          candidate_id: candidate,
        },
        client
      );
      expect(applied.structuredContent).toMatchObject({
        outcome: 'ok',
        applied: true,
        resourceMoves: [{ oldPath: owner, newPath: join(root, 'src/RenamedWidget.php') }],
      });
      expect(await Bun.file(owner).exists()).toBe(false);
      expect(await readFile(join(root, 'src/RenamedWidget.php'), 'utf8')).toContain(
        'class RenamedWidget'
      );
      expect(await readFile(consumer, 'utf8')).toContain('new RenamedWidget()');
      expect((await client.getDiagnosticsReport(consumer)).freshness.status).toBe('current');
    });
  }, 60_000);

  it('moves mutually importing mjs files once into new nested directories', async () => {
    await fixture(async (root, client) => {
      const moves = [
        { old_path: join(root, 'src/alpha.mjs'), new_path: join(root, 'src/core/alpha.mjs') },
        { old_path: join(root, 'src/beta.mjs'), new_path: join(root, 'src/core/beta.mjs') },
      ];
      const preview = await renameFileTool.handler({ moves }, client);
      const candidate = preview.structuredContent?.candidateId as string;
      expect(candidate).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(await Bun.file(join(root, 'src/core')).exists()).toBe(false);
      const applied = await renameFileTool.handler(
        { moves, dry_run: false, candidate_id: candidate },
        client
      );
      expect(applied.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
      expect(await readFile(join(root, 'src/core/alpha.mjs'), 'utf8')).toContain("'./beta.mjs'");
      expect(await readFile(join(root, 'src/core/beta.mjs'), 'utf8')).toContain("'./alpha.mjs'");
      expect(await readFile(join(root, 'src/core/alpha.mjs'), 'utf8')).not.toContain('.mjss');
    });
  }, 60_000);

  it('serves completions/code-actions through both providers and batches file-move planning per provider', async () => {
    await fixture(async (root, client) => {
      const files = [join(root, 'src/app.ts'), join(root, 'src/App.php')];
      for (const file of files) {
        const completions = await getCompletionsTool.handler(
          { file_path: file, line: 2, character: 1, resolve_limit: 0 },
          client
        );
        expect(completions.structuredContent?.outcome).not.toBe('unavailable');
        const actions = await getCodeActionsTool.handler(
          { file_path: file, start_line: 1, start_character: 1, end_line: 1, end_character: 1 },
          client
        );
        expect(actions.structuredContent?.outcome).not.toBe('unavailable');
      }
      const mixedMoves = [
        { old_path: join(root, 'src/math.ts'), new_path: join(root, 'src/math-core.ts') },
        { old_path: join(root, 'src/Math.php'), new_path: join(root, 'src/MathCore.php') },
      ];
      await expect(renameFileTool.handler({ moves: mixedMoves }, client)).rejects.toMatchObject({
        outcome: { code: 'LSP_METHOD_UNSUPPORTED', method: 'workspace/willRenameFiles' },
      });
      expect(await readFile(join(root, 'src/math.ts'), 'utf8')).toContain('doubleValue');
      expect(await readFile(join(root, 'src/Math.php'), 'utf8')).toContain('doubleValue');

      const typescriptMoves = [mixedMoves[0]];
      const preview = await renameFileTool.handler({ moves: typescriptMoves }, client);
      const candidate = preview.structuredContent?.candidateId as string;
      expect(candidate).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(preview.content[0]?.text).toContain(`Candidate ID: ${candidate}`);
      expect(preview.content[0]?.text).toContain("import { doubleValue } from './math.js'");
      const staleCandidate = await renameFileTool.handler(
        {
          moves: typescriptMoves,
          dry_run: false,
          candidate_id: `sha256:${'0'.repeat(64)}`,
        },
        client
      );
      expect(staleCandidate).toMatchObject({
        isError: true,
        structuredContent: { code: 'LSP_FILE_RENAME_STALE', applied: false },
      });
      expect(await Bun.file(join(root, 'src/math.ts')).exists()).toBe(true);
      expect(await Bun.file(join(root, 'src/math-core.ts')).exists()).toBe(false);
      expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('./math.js');
      const applied = await renameFileTool.handler(
        { moves: typescriptMoves, dry_run: false, candidate_id: candidate },
        client
      );
      expect(applied.structuredContent).toMatchObject({ outcome: 'ok', applied: true });
      expect(await readFile(join(root, 'src/math-core.ts'), 'utf8')).toContain('doubleValue');
      expect(await readFile(join(root, 'src/app.ts'), 'utf8')).toContain('./math-core.js');
    });
  }, 60_000);
});
