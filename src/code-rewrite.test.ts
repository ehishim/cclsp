import { describe, expect, it, jest } from 'bun:test';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import type { AstRewriteOutcome } from './ast/types.js';
import { LSPClient } from './lsp-client.js';
import { codeRewriteTool } from './tools/code-rewrite.js';

const execFileAsync = promisify(execFile);

async function withClient(
  files: Record<string, string>,
  action: (root: string, client: LSPClient) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cclsp-rewrite-client-'));
  const config = join(tmpdir(), `cclsp-empty-${process.pid}-${Math.random()}.json`);
  try {
    const entries = Object.entries(files);
    for (let offset = 0; offset < entries.length; offset += 250) {
      await Promise.all(
        entries.slice(offset, offset + 250).map(async ([relative, content]) => {
          const absolute = join(root, relative);
          await mkdir(join(absolute, '..'), { recursive: true });
          await writeFile(absolute, content);
        })
      );
    }
    await writeFile(config, JSON.stringify({ servers: [] }));
    const client = new LSPClient(config, root);
    try {
      await action(root, client);
    } finally {
      await client.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(config, { force: true });
  }
}

function ok(result: AstRewriteOutcome) {
  expect(result.outcome).toBe('ok');
  if (result.outcome !== 'ok') throw new Error(JSON.stringify(result));
  return result;
}

describe('code_rewrite', () => {
  it('defaults to stable dry-run and applies the inspected multi-file candidate', async () => {
    await withClient(
      { 'src/a.ts': 'const a = foo(1);\n', 'src/b.ts': 'const b = foo(2);\n' },
      async (root, client) => {
        const input = {
          pattern: 'foo($ARG)',
          replacement: 'bar(0, $ARG)',
          language: 'typescript',
          path: 'src',
        };
        const first = ok(await client.codeRewrite(input));
        const second = ok(await client.codeRewrite(input));
        expect(first).toMatchObject({ dryRun: true, changesPlanned: 2, filesChanged: 2 });
        expect(first.candidateId).toBe(second.candidateId);
        expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('const a = foo(1);\n');

        const applied = ok(
          await client.codeRewrite({
            ...input,
            dryRun: false,
            candidateId: first.candidateId,
          })
        );
        expect(applied).toMatchObject({
          dryRun: false,
          filesModified: [join(root, 'src/a.ts'), join(root, 'src/b.ts')],
          changesApplied: 2,
          rollback: { attempted: false },
        });
        expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('const a = bar(0, 1);\n');
        expect(
          await client.astSearch({
            language: 'typescript',
            pattern: 'bar($ZERO, $ARG)',
            path: 'src/a.ts',
          })
        ).toMatchObject({ outcome: 'ok', matches: [{}] });
      }
    );
  });

  it('rewrites CSS through the same contract as every other language', async () => {
    // CSS carries no per-language exception: the preview, the exact candidate,
    // the atomic apply and the parse validation are language-agnostic, so a
    // refusal here would be a special case with no mechanism behind it.
    await withClient(
      { 'panel.module.css': '.panel {\n  color: red;\n}\n' },
      async (root, client) => {
        const input = {
          pattern: 'color: red',
          // A CSS declaration node carries its own terminating `;`, exactly as a
          // statement does in every other language here, so the replacement
          // supplies one. Preview shows the matched bytes before anything moves.
          replacement: 'color: var(--danger);',
          language: 'css',
          path: 'panel.module.css',
        };
        const preview = ok(await client.codeRewrite(input));
        expect(preview).toMatchObject({ dryRun: true, changesPlanned: 1, filesChanged: 1 });
        expect(preview.changes[0]?.before).toBe('color: red;');
        expect(await readFile(join(root, 'panel.module.css'), 'utf8')).toContain('color: red;');

        const applied = ok(
          await client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId })
        );
        expect(applied).toMatchObject({ dryRun: false, changesApplied: 1 });
        expect(await readFile(join(root, 'panel.module.css'), 'utf8')).toBe(
          '.panel {\n  color: var(--danger);\n}\n'
        );
      }
    );
  });

  it('never lets a tree the parser only recovered authorise a byte mutation', async () => {
    // The load-bearing safety boundary of error-tolerant SEARCH: search reads a
    // recovered tree as presence evidence, but a rewrite computes byte ranges
    // from it, and a range derived from an unparsed region would corrupt the
    // file. Refusal here is what makes tolerance safe over there.
    await withClient(
      {
        'sound.ts': 'const sound = foo(1);\n',
        'broken.ts': 'const broken = foo(2);\nfunction wrong( {\n',
        'style.css': '.panel { color: red; }\n@custom-variant dark (&:where(\n',
      },
      async (root, client) => {
        const before = await readFile(join(root, 'broken.ts'), 'utf8');

        const explicit = await client.codeRewrite({
          pattern: 'foo($ARG)',
          replacement: 'bar($ARG)',
          language: 'typescript',
          path: 'broken.ts',
        });
        expect(explicit).toMatchObject({
          outcome: 'rejected',
          code: 'AST_PARSE_FAILED',
        });

        // A directory scope must refuse too, rather than quietly rewriting the
        // sound file and leaving the scope half-applied.
        const scope = await client.codeRewrite({
          pattern: 'foo($ARG)',
          replacement: 'bar($ARG)',
          language: 'typescript',
        });
        expect(scope).toMatchObject({
          outcome: 'rejected',
          code: 'AST_REWRITE_SCOPE_INCOMPLETE',
        });

        // CSS carries no exception in either direction: it is admitted for
        // rewrite, and refused on an error-bearing source like every language.
        expect(
          await client.codeRewrite({
            pattern: 'color: red',
            replacement: 'color: blue;',
            language: 'css',
            path: 'style.css',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_PARSE_FAILED' });

        expect(await readFile(join(root, 'broken.ts'), 'utf8')).toBe(before);
        expect(await readFile(join(root, 'sound.ts'), 'utf8')).toBe('const sound = foo(1);\n');
      }
    );
  });

  it('serializes concurrent apply calls so only one candidate mutates', async () => {
    await withClient({ 'a.ts': 'const a = foo(1);\n' }, async (root, client) => {
      const input = {
        pattern: 'foo($ARG)',
        replacement: 'bar(0, $ARG)',
        language: 'typescript',
        path: 'a.ts',
      };
      const preview = ok(await client.codeRewrite(input));
      const results = await Promise.all([
        client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId }),
        client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId }),
      ]);
      expect(results.filter((result) => result.outcome === 'ok')).toHaveLength(1);
      expect(results.filter((result) => result.outcome === 'rejected')).toEqual([
        expect.objectContaining({ code: 'AST_REWRITE_STALE' }),
      ]);
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = bar(0, 1);\n');
    });
  });

  it('requires a candidate and rejects changed-since-preview input without writes', async () => {
    await withClient({ 'a.ts': 'const a = foo(1);\n' }, async (root, client) => {
      const input = {
        pattern: 'foo($ARG)',
        replacement: 'bar(0, $ARG)',
        language: 'typescript',
        path: 'a.ts',
      };
      expect(await client.codeRewrite({ ...input, dryRun: false })).toMatchObject({
        outcome: 'rejected',
        code: 'AST_REWRITE_PREVIEW_REQUIRED',
      });
      const preview = ok(await client.codeRewrite(input));
      await writeFile(join(root, 'a.ts'), 'const a = foo(9);\n');
      expect(
        await client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId })
      ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_STALE' });
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('const a = foo(9);\n');
    });
  });

  it('refuses Git-modified matched files while admitting a clean committed target', async () => {
    await withClient({ 'a.ts': 'const a = foo(1);\n' }, async (root, client) => {
      await execFileAsync('git', ['init', '-q'], { cwd: root });
      await execFileAsync('git', ['add', 'a.ts'], { cwd: root });
      await execFileAsync(
        'git',
        [
          '-c',
          'user.name=cclsp',
          '-c',
          'user.email=cclsp@example.invalid',
          'commit',
          '-qm',
          'fixture',
        ],
        { cwd: root }
      );
      const input = {
        pattern: 'foo($ARG)',
        replacement: 'bar(0, $ARG)',
        language: 'typescript',
        path: 'a.ts',
      };
      const preview = ok(await client.codeRewrite(input));
      await writeFile(join(root, 'a.ts'), 'const a = foo(2);\n');
      expect(await client.codeRewrite(input)).toMatchObject({
        outcome: 'rejected',
        code: 'AST_REWRITE_TARGET_DIRTY',
      });
      expect(
        await client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId })
      ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_TARGET_DIRTY' });
    });
  });

  it('rejects overlaps, excessive matches, and invalid complete outputs before writes', async () => {
    await withClient(
      {
        'overlap.ts': 'const x = foo(1);\n',
        'many.ts': Array.from({ length: 101 }, (_, index) => `foo(${index});`).join('\n'),
      },
      async (_root, client) => {
        expect(
          await client.codeRewrite({
            pattern: '$NODE',
            replacement: 'wrap($NODE)',
            language: 'typescript',
            path: 'overlap.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_CONFLICT' });
        expect(
          await client.codeRewrite({
            pattern: 'foo($ARG)',
            replacement: 'bar(0, $ARG)',
            language: 'typescript',
            path: 'many.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_TOO_MANY_MATCHES' });
        expect(
          await client.codeRewrite({
            pattern: 'foo($ARG)',
            replacement: 'bar(',
            language: 'typescript',
            path: 'overlap.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_REPLACEMENT_INVALID' });
      }
    );
  });

  it('binds no-op identities to matched input bytes', async () => {
    await withClient({ 'a.ts': 'const a = foo(1);\n' }, async (root, client) => {
      const input = {
        pattern: 'foo($ARG)',
        replacement: 'foo($ARG)',
        language: 'typescript',
        path: 'a.ts',
      };
      const preview = ok(await client.codeRewrite(input));
      expect(preview.changesPlanned).toBe(0);
      await writeFile(join(root, 'a.ts'), 'const a = foo(2);\n');
      expect(
        await client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId })
      ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_STALE' });
    });
  });

  it('preserves BOM, CRLF, non-ASCII text, and UTF-16 preview coordinates', async () => {
    await withClient({ 'a.ts': '\ufeffconst café = foo("😀");\r\n' }, async (root, client) => {
      const input = {
        pattern: 'foo($ARG)',
        replacement: 'bar(0, $ARG)',
        language: 'typescript',
        path: 'a.ts',
      };
      const preview = ok(await client.codeRewrite(input));
      expect(preview.changes[0]?.range.start.character).toBe(14);
      const applied = ok(
        await client.codeRewrite({ ...input, dryRun: false, candidateId: preview.candidateId })
      );
      expect(applied.dryRun).toBe(false);
      expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe(
        '\ufeffconst café = bar(0, "😀");\r\n'
      );
    });
  });

  it('scans a complete 5,000-file scope and refuses the same scope when capped', async () => {
    const files = Object.fromEntries(
      Array.from({ length: 5_000 }, (_, index) => [
        `f${String(index).padStart(4, '0')}.ts`,
        index === 4_999 ? 'const hit = foo(1);\n' : `const v${index} = ${index};\n`,
      ])
    );
    await withClient(files, async (root, client) => {
      const input = {
        pattern: 'foo($ARG)',
        replacement: 'bar(0, $ARG)',
        language: 'typescript',
      };
      expect(await client.codeRewrite(input)).toMatchObject({
        outcome: 'ok',
        filesMatched: 1,
        changesPlanned: 1,
      });
      await writeFile(join(root, 'overflow.ts'), 'const overflow = 1;\n');
      expect(await client.codeRewrite(input)).toMatchObject({
        outcome: 'rejected',
        code: 'AST_REWRITE_SCOPE_INCOMPLETE',
      });
    });
  }, 30_000);

  it('returns typed capture, semantic rename, generated, and encoding refusals', async () => {
    await withClient(
      {
        'a.ts': 'const a = foo(1);\n',
        'generated.ts': '// @generated\nconst a = foo(1);\n',
      },
      async (root, client) => {
        expect(
          await client.codeRewrite({
            pattern: 'foo($ARG)',
            replacement: 'bar($MISSING)',
            language: 'typescript',
            path: 'a.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_CAPTURE_INVALID' });
        expect(
          await client.codeRewrite({
            pattern: 'foo($ARG)',
            replacement: 'bar($ARG)',
            language: 'typescript',
            path: 'a.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_SEMANTIC_RENAME' });
        expect(
          await client.codeRewrite({
            pattern: 'foo($ARG)',
            replacement: 'bar(0, $ARG)',
            language: 'typescript',
            path: 'generated.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_TARGET_UNSAFE' });
        await writeFile(join(root, 'bad.ts'), Buffer.from([0xff, 0xfe]));
        expect(
          await client.codeRewrite({
            pattern: 'foo($ARG)',
            replacement: 'bar(0, $ARG)',
            language: 'typescript',
            path: 'bad.ts',
          })
        ).toMatchObject({ outcome: 'rejected', code: 'AST_REWRITE_ENCODING_INVALID' });
      }
    );
  });

  it('projects schema, structured errors, and one-indexed text', async () => {
    expect(codeRewriteTool.inputSchema).toMatchObject({
      required: ['pattern', 'replacement', 'language'],
      properties: { dry_run: { default: true }, candidate_id: { type: 'string' } },
    });
    const client = {
      codeRewrite: jest.fn().mockResolvedValue({
        outcome: 'rejected',
        provider: 'tree-sitter',
        isError: true,
        code: 'AST_REWRITE_STALE',
        reason: 'changed',
      }),
    } as unknown as LSPClient;
    const result = await codeRewriteTool.handler(
      { pattern: 'foo($A)', replacement: 'bar(0, $A)', language: 'typescript' },
      client
    );
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'AST_REWRITE_STALE' },
    });
    expect(result.content[0]?.text).toContain('AST_REWRITE_STALE: changed');
  });
});
