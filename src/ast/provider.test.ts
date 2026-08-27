import { describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AstProvider } from './provider.js';
import { AST_MAX_FILE_BYTES } from './types.js';

async function withProject(
  files: Record<string, string>,
  action: (root: string, provider: AstProvider) => Promise<void>
): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), 'cclsp-ast-'));
  try {
    for (const [path, content] of Object.entries(files)) {
      const absolute = join(root, path);
      await mkdir(join(absolute, '..'), { recursive: true });
      await writeFile(absolute, content);
    }
    const provider = new AstProvider(root);
    try {
      await action(root, provider);
    } finally {
      await provider.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const LANGUAGE_SMOKES = [
  ['typescript', 'sample.ts', 'function f() {}', 'function f() {}'],
  ['tsx', 'sample.tsx', 'const x = <div />;', 'const $NAME = $VALUE'],
  ['javascript', 'sample.js', 'function f() {}', 'function f() {}'],
  ['jsx', 'sample.jsx', 'const x = <div />;', 'const $NAME = $VALUE'],
  ['python', 'sample.py', 'def f():\n    pass\n', 'def f():\n    pass'],
  ['php', 'sample.php', '<?php function f() {}', 'function f() {}'],
  ['go', 'sample.go', 'package p\nfunc f() {}\n', 'func f() {}'],
  ['rust', 'sample.rs', 'fn f() {}\n', 'fn f() {}'],
  ['java', 'Sample.java', 'class Sample {}\n', 'class Sample {}'],
] as const;

describe('AstProvider', () => {
  for (const [language, file, source, pattern] of LANGUAGE_SMOKES) {
    it(`loads and searches the installed ${language} grammar`, async () => {
      await withProject({ [file]: source }, async (_root, provider) => {
        const result = await provider.search({ language, pattern, path: file });
        expect(result.outcome).toBe('ok');
        if (result.outcome === 'ok') {
          expect(result.provider).toBe('tree-sitter');
          expect(result.matches.length).toBeGreaterThan(0);
        }
      });
    });
  }

  const DECLARATION_SMOKES = [
    ['typescript', 'sample.ts', 'class Box { run() {} }', ['Box', 'Box.run']],
    ['tsx', 'sample.tsx', 'class Box { run() { return <div />; } }', ['Box', 'Box.run']],
    ['javascript', 'sample.js', 'class Box { run() {} }', ['Box', 'Box.run']],
    ['jsx', 'sample.jsx', 'class Box { run() { return <div />; } }', ['Box', 'Box.run']],
    ['python', 'sample.py', 'class Box:\n    def run(self):\n        pass\n', ['Box', 'Box.run']],
    ['php', 'sample.php', '<?php class Box { function run() {} }', ['Box', 'Box.run']],
    ['go', 'sample.go', 'package p\ntype Box struct {}\nfunc (b Box) Run() {}\n', ['Box', 'Run']],
    ['rust', 'sample.rs', 'struct Box {}\nimpl Box { fn run() {} }\n', ['Box', 'run']],
    ['java', 'Sample.java', 'class Box { void run() {} }', ['Box', 'Box.run']],
  ] as const;

  for (const [language, file, source, expectedNames] of DECLARATION_SMOKES) {
    it(`extracts representative ${language} declarations`, async () => {
      await withProject({ [file]: source }, async (root, provider) => {
        const result = await provider.documentSymbols(join(root, file));
        expect(result.outcome).toBe('ok');
        if (result.outcome !== 'ok') return;
        const names = result.value.flatMap((symbol) => {
          if (!('children' in symbol)) return [symbol.name];
          return [
            symbol.name,
            ...(symbol.children ?? []).map((child) => `${symbol.name}.${child.name}`),
          ];
        });
        expect(names).toEqual([...expectedNames]);
      });
    });
  }

  it('captures single and variadic metavariables with stable ranges', async () => {
    await withProject(
      { 'sample.ts': 'function alpha(a: number, b: string) {\n  return a;\n}\n' },
      async (_root, provider) => {
        const result = await provider.search({
          language: 'typescript',
          path: 'sample.ts',
          pattern: 'function $NAME($$$ARGS) { $$$BODY }',
        });
        expect(result.outcome).toBe('ok');
        if (result.outcome !== 'ok') return;
        expect(result.matches).toHaveLength(1);
        expect(result.matches[0]?.captures.map((capture) => capture.name)).toEqual([
          'NAME',
          'ARGS',
          'BODY',
        ]);
        expect(result.matches[0]?.captures[0]?.text).toBe('alpha');
        expect(result.matches[0]?.captures[1]?.range.start).toEqual({ line: 0, character: 15 });
      }
    );
  });

  it('matches zero-length variadics, repeated bindings, and escaped dollars exactly', async () => {
    await withProject(
      {
        'sample.ts': [
          'function empty() {}',
          'const same = same;',
          'const different = other;',
          'const $NAME = 1;',
        ].join('\n'),
      },
      async (_root, provider) => {
        const empty = await provider.search({
          language: 'typescript',
          path: 'sample.ts',
          pattern: 'function $NAME($$$ARGS) { $$$BODY }',
        });
        expect(empty.outcome === 'ok' && empty.matches[0]?.captures[1]?.text).toBe('');
        expect(empty.outcome === 'ok' && empty.matches[0]?.captures[1]?.range).toEqual({
          start: { line: 0, character: 16 },
          end: { line: 0, character: 16 },
        });

        const repeated = await provider.search({
          language: 'typescript',
          path: 'sample.ts',
          pattern: 'const $NAME = $NAME',
        });
        expect(repeated.outcome === 'ok' && repeated.matches).toHaveLength(1);
        expect(repeated.outcome === 'ok' && repeated.matches[0]?.captures[0]?.text).toBe('same');

        const escaped = await provider.search({
          language: 'typescript',
          path: 'sample.ts',
          pattern: 'const \\$NAME = $VALUE',
        });
        expect(escaped.outcome === 'ok' && escaped.matches).toHaveLength(1);
        expect(escaped.outcome === 'ok' && escaped.matches[0]?.captures[0]?.name).toBe('VALUE');
      }
    );
  });

  it('keeps a trailing empty variadic capture range at one anchor', async () => {
    await withProject({ 'sample.ts': 'foo(x);' }, async (_root, provider) => {
      const result = await provider.search({
        language: 'typescript',
        path: 'sample.ts',
        pattern: 'foo($A, $$$REST)',
      });
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      expect(result.matches[0]?.captures.find((capture) => capture.name === 'REST')).toMatchObject({
        text: '',
        range: {
          start: { line: 0, character: 6 },
          end: { line: 0, character: 6 },
        },
      });
    });
  });

  it('extracts Go package variables and constants', async () => {
    await withProject(
      { 'sample.go': 'package p\nvar Top = 1\nconst C = 2\nfunc F() {}\n' },
      async (root, provider) => {
        const result = await provider.documentSymbols(join(root, 'sample.go'));
        expect(result.outcome).toBe('ok');
        if (result.outcome !== 'ok') return;
        expect(result.value.map((symbol) => [symbol.name, symbol.kind])).toEqual([
          ['Top', 13],
          ['C', 14],
          ['F', 12],
        ]);
      }
    );
  });

  it('bounds result counts and exposes the effective ceiling', async () => {
    await withProject(
      {
        'sample.ts': Array.from({ length: 4 }, (_, index) => `const v${index} = ${index};`).join(
          '\n'
        ),
      },
      async (_root, provider) => {
        const result = await provider.search({
          language: 'typescript',
          path: 'sample.ts',
          pattern: 'const $NAME = $VALUE',
          maxResults: 2,
        });
        expect(result).toMatchObject({
          outcome: 'ok',
          matches: [{}, {}],
          effectiveMaxResults: 2,
          truncated: true,
        });
        const clampedWithoutOmission = await provider.search({
          language: 'typescript',
          path: 'sample.ts',
          pattern: 'const v0 = 0',
          maxResults: 5_000,
        });
        expect(clampedWithoutOmission).toMatchObject({
          outcome: 'ok',
          matches: [{}],
          effectiveMaxResults: 1_000,
          truncated: false,
        });

        const invalid = await provider.search({
          language: 'typescript',
          pattern: '$NAME',
          maxResults: 0,
        });
        expect(invalid.outcome === 'rejected' && invalid.code).toBe('AST_ARGUMENT_INVALID');
      }
    );
  });

  it('refreshes content, add, delete, and rename without rebuilding per unchanged call', async () => {
    await withProject({ 'a.ts': 'const first = 1;\n' }, async (root, provider) => {
      const search = () =>
        provider.search({
          language: 'typescript',
          pattern: 'const $NAME = $VALUE',
          maxResults: 20,
        });
      const [initialA, initialB] = await Promise.all([search(), search()]);
      expect(initialA.outcome).toBe('ok');
      expect(initialB.outcome).toBe('ok');

      await writeFile(join(root, 'a.ts'), 'const edited = 2;\n');
      let result = await search();
      expect(result.outcome === 'ok' && result.matches[0]?.captures[0]?.text).toBe('edited');

      await writeFile(join(root, 'b.ts'), 'const added = 3;\n');
      result = await search();
      expect(
        result.outcome === 'ok' && result.matches.map((match) => match.captures[0]?.text)
      ).toEqual(['edited', 'added']);

      await rename(join(root, 'b.ts'), join(root, 'c.ts'));
      result = await search();
      expect(
        result.outcome === 'ok' && result.matches.some((match) => match.file.endsWith('c.ts'))
      ).toBe(true);

      await rm(join(root, 'a.ts'));
      result = await search();
      expect(
        result.outcome === 'ok' && result.matches.map((match) => match.captures[0]?.text)
      ).toEqual(['added']);
    });
  });

  it('enforces the file cap after a pure content edit', async () => {
    await withProject({ 'sample.ts': 'const small = 1;\n' }, async (root, provider) => {
      const searchRoot = () =>
        provider.search({ language: 'typescript', pattern: 'const $NAME = $VALUE' });
      expect((await searchRoot()).outcome).toBe('ok');

      await writeFile(join(root, 'sample.ts'), 'x'.repeat(AST_MAX_FILE_BYTES * 6));
      const directoryResult = await searchRoot();
      expect(directoryResult).toMatchObject({
        outcome: 'ok',
        matches: [],
        filesScanned: 0,
        filesSkippedOversized: 1,
        parseFailureCount: 0,
      });

      await writeFile(join(root, 'sample.ts'), 'const shrunk = 2;\n');
      const shrunkResult = await searchRoot();
      expect(shrunkResult).toMatchObject({
        outcome: 'ok',
        filesScanned: 1,
        filesSkippedOversized: 0,
      });
      expect(shrunkResult.outcome === 'ok' && shrunkResult.matches[0]?.captures[0]?.text).toBe(
        'shrunk'
      );

      await writeFile(join(root, 'sample.ts'), 'x'.repeat(AST_MAX_FILE_BYTES * 6));
      const explicitResult = await provider.search({
        language: 'typescript',
        path: 'sample.ts',
        pattern: '$NAME',
      });
      expect(explicitResult).toMatchObject({
        outcome: 'rejected',
        code: 'AST_FILE_OVERSIZED',
        bytes: AST_MAX_FILE_BYTES * 6,
        cap: AST_MAX_FILE_BYTES,
      });
    });
  });

  it('types invalid pattern, unsupported language, oversized file, and escaped paths', async () => {
    await withProject({ 'sample.ts': 'const x = 1;\n' }, async (root, provider) => {
      const invalid = await provider.search({ language: 'typescript', pattern: 'function {' });
      expect(invalid.outcome === 'rejected' && invalid.code).toBe('AST_PATTERN_INVALID');

      const unsupported = await provider.search({ language: 'ruby', pattern: 'x' });
      expect(unsupported.outcome === 'rejected' && unsupported.code).toBe(
        'AST_LANGUAGE_UNSUPPORTED'
      );

      await writeFile(join(root, 'large.ts'), 'x'.repeat(AST_MAX_FILE_BYTES + 1));
      const oversized = await provider.search({
        language: 'typescript',
        pattern: '$NAME',
        path: 'large.ts',
      });
      expect(oversized.outcome === 'rejected' && oversized.code).toBe('AST_FILE_OVERSIZED');

      await writeFile(join(root, 'broken.ts'), 'const = ;');
      const parseFailure = await provider.search({
        language: 'typescript',
        pattern: 'const $NAME = $VALUE',
        path: 'broken.ts',
      });
      expect(parseFailure.outcome === 'rejected' && parseFailure.code).toBe('AST_PARSE_FAILED');

      const invalidPath = await provider.search({
        language: 'typescript',
        pattern: '$NAME',
        path: 'missing.ts',
      });
      expect(invalidPath.outcome === 'rejected' && invalidPath.code).toBe('AST_PATH_INVALID');

      const outside = await mkdtemp(join(tmpdir(), 'cclsp-ast-outside-'));
      try {
        await writeFile(join(outside, 'outside.ts'), 'const escaped = 1;');
        await symlink(join(outside, 'outside.ts'), join(root, 'escape.ts'));
        const escaped = await provider.search({
          language: 'typescript',
          pattern: 'const $NAME = $VALUE',
          path: 'escape.ts',
        });
        expect(escaped.outcome === 'rejected' && escaped.code).toBe('AST_PATH_ESCAPED');
      } finally {
        await rm(outside, { recursive: true, force: true });
      }
    });
  });

  it('reports UTF-16 columns without per-range source conversion', async () => {
    await withProject({ 'unicode.ts': 'const café = "😀";\n' }, async (_root, provider) => {
      const result = await provider.search({
        language: 'typescript',
        path: 'unicode.ts',
        pattern: 'const $NAME = $VALUE',
      });
      expect(result.outcome).toBe('ok');
      if (result.outcome !== 'ok') return;
      expect(result.matches[0]?.captures).toMatchObject([
        {
          name: 'NAME',
          text: 'café',
          range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } },
        },
        {
          name: 'VALUE',
          text: '"😀"',
          range: { start: { line: 0, character: 13 }, end: { line: 0, character: 17 } },
        },
      ]);
    });
  });

  it('keeps maximum-size range extraction linear in source size', async () => {
    const source = Array.from(
      { length: 8_000 },
      (_, index) =>
        `const maximum_scope_value_${String(index).padStart(5, '0')}_xxxxxxxxxxxxxxxx = ${index};`
    ).join('\n');
    expect(Buffer.byteLength(source)).toBeGreaterThan(400_000);
    expect(Buffer.byteLength(source)).toBeLessThanOrEqual(AST_MAX_FILE_BYTES);

    await withProject({ 'maximum.ts': source }, async (root, provider) => {
      const symbolsStarted = performance.now();
      const symbols = await provider.documentSymbols(join(root, 'maximum.ts'));
      const symbolsElapsedMs = performance.now() - symbolsStarted;
      expect(symbols.outcome).toBe('ok');
      expect(symbols.outcome === 'ok' && symbols.value).toHaveLength(8_000);
      expect(symbolsElapsedMs).toBeLessThan(3_000);

      const searchStarted = performance.now();
      const search = await provider.search({
        language: 'typescript',
        path: 'maximum.ts',
        pattern: 'const $NAME = $VALUE',
        maxResults: 1_000,
      });
      const searchElapsedMs = performance.now() - searchStarted;
      expect(search).toMatchObject({ outcome: 'ok', truncated: true });
      expect(search.outcome === 'ok' ? search.matches : []).toHaveLength(1_000);
      expect(searchElapsedMs).toBeLessThan(3_000);
    });
  }, 10_000);

  it('extracts syntax-only document symbols', async () => {
    await withProject(
      { 'sample.ts': 'class Box { method() {} }\nfunction top() {}\n' },
      async (root, provider) => {
        const result = await provider.documentSymbols(join(root, 'sample.ts'));
        expect(result.outcome).toBe('ok');
        if (result.outcome !== 'ok') return;
        expect(result.provider).toBe('tree-sitter');
        expect(result.value.map((symbol) => symbol.name)).toEqual(['Box', 'top']);
        const box = result.value[0];
        expect(box && 'children' in box ? box.children?.[0]?.name : undefined).toBe('method');
      }
    );
  });
});

describe('a structural zero must say which kind of zero it is', () => {
  const PROJECT = {
    'a.ts': 'export function isUnder(x: string) { return x; }\n',
    'b.ts': 'export function normalizeRoot(p: string) { return p; }\nconst r = normalizeRoot("x");\n',
  };

  it('marks an alternation-shaped pattern with the node kind it was actually parsed as', async () => {
    await withProject(PROJECT, async (_root, provider) => {
      const result = await provider.search({
        pattern: 'isUnder|normalizeRoot',
        language: 'typescript',
      });
      if (result.outcome !== 'ok') throw new Error(`expected ok, got ${result.outcome}`);
      expect(result.matches).toHaveLength(0);
      expect(result.perPattern).toHaveLength(1);
      const only = result.perPattern[0];
      expect(only?.matches).toBe(0);
      // The whole point: the caller can see their "alternation" became one expression.
      expect(only?.note).toContain('binary_expression');
      expect(only?.note).toContain('--pattern');
    });
  });

  // Every one of these is a true negative that has nothing to do with a regex habit.
  // The first version of this fix noted all of them, because it keyed on "not an
  // identifier" rather than on the alternation shape, trading one spurious-warning
  // class for a wider one. An identifier-only control never exercised that.
  const TRUE_NEGATIVES: Array<[string, string]> = [
    ['bare name', 'zzzNeverDeclaredZZZ'],
    ['call expression', 'console.log("definitely_not_present_xyz")'],
    ['class declaration', 'class DefinitelyNotPresentClassXYZ {}'],
    ['ordinary addition', 'reallyNotHereAAA + reallyNotHereBBB'],
  ];

  for (const [shape, pattern] of TRUE_NEGATIVES) {
    it(`leaves a genuine absence (${shape}) as a plain zero, with no note to explain away`, async () => {
      await withProject(PROJECT, async (_root, provider) => {
        const result = await provider.search({ pattern, language: 'typescript' });
        if (result.outcome !== 'ok') throw new Error(`expected ok, got ${result.outcome}`);
        expect(result.matches).toHaveLength(0);
        expect(result.perPattern[0]?.matches).toBe(0);
        expect(result.perPattern[0]?.note).toBeUndefined();
      });
    });
  }

  it('attributes each count to its own pattern and names the one that found nothing', async () => {
    await withProject(PROJECT, async (_root, provider) => {
      const result = await provider.search({
        pattern: ['isUnder', 'normalizeRoot', 'zzzNeverDeclaredZZZ'],
        language: 'typescript',
      });
      if (result.outcome !== 'ok') throw new Error(`expected ok, got ${result.outcome}`);
      expect(result.perPattern.map((row) => [row.pattern, row.matches])).toEqual([
        ['isUnder', 1],
        ['normalizeRoot', 2],
        ['zzzNeverDeclaredZZZ', 0],
      ]);
      expect(result.matches).toHaveLength(3);
    });
  });

  it('refuses an unparseable pattern by naming which of several it was', async () => {
    await withProject(PROJECT, async (_root, provider) => {
      const result = await provider.search({
        pattern: ['isUnder', 'export function $NAME'],
        language: 'typescript',
      });
      if (result.outcome !== 'rejected') throw new Error('expected rejection');
      expect(result.code).toBe('AST_PATTERN_INVALID');
      expect(result.reason).toContain('pattern 2 of 2');
    });
  });

  it('never reports a pattern absent because an earlier pattern spent the budget', async () => {
    await withProject(
      {
        // Ordered so the prolific pattern is scanned to exhaustion first.
        'aaa-many.ts': `${'const alpha = 1;\n'.repeat(30)}`,
        'zzz-one.ts': 'const omega = 1;\n',
      },
      async (_root, provider) => {
        const result = await provider.search({
          pattern: ['alpha', 'omega'],
          language: 'typescript',
          maxResults: 2,
        });
        if (result.outcome !== 'ok') throw new Error(`expected ok, got ${result.outcome}`);
        expect(result.truncated).toBe(true);
        // A zero here would be the budget running out, reported as absence.
        expect(result.perPattern[1]?.pattern).toBe('omega');
        expect(result.perPattern[1]?.matches).toBeGreaterThan(0);
      }
    );
  });
});
