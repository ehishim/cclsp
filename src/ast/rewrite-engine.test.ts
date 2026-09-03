import { describe, expect, it } from 'bun:test';
import type { Node as TsNode, Tree as TsTree } from 'web-tree-sitter';
import { RewriteBuildError, RewriteEngine, type RewriteSourceFile } from './rewrite-engine.js';
import type { CompiledPattern, ExactStructuralMatch } from './types.js';

const range = {
  start: { line: 0, character: 0 },
  end: { line: 0, character: 6 },
};

function match(
  text: string,
  startIndex: number,
  endIndex: number,
  captures: Array<{ name: string; variadic?: boolean; text: string }> = []
): ExactStructuralMatch {
  return {
    file: '/root/a.ts',
    startIndex,
    endIndex,
    range,
    matchedText: text,
    captures: captures.map((capture) => ({
      name: capture.name,
      variadic: capture.variadic ?? false,
      text: capture.text,
      startIndex,
      endIndex,
      range,
    })),
  };
}

function compiled(variables: Array<{ name: string; variadic?: boolean }>): CompiledPattern {
  return {
    tree: {} as TsTree,
    node: {} as TsNode,
    metavariables: variables.map((variable, order) => ({
      name: variable.name,
      variadic: variable.variadic ?? false,
      order,
      sentinel: `S${order}`,
    })),
  };
}

function build(
  source: string,
  matches: ExactStructuralMatch[],
  replacement: string,
  variables: Array<{ name: string; variadic?: boolean }>
) {
  const file: RewriteSourceFile = {
    absolutePath: '/root/a.ts',
    relativePath: 'a.ts',
    mode: 0o100644,
    original: Buffer.from(source),
    source,
    matches,
  };
  return new RewriteEngine().build({
    root: '/root',
    language: 'typescript',
    pattern: 'fixture',
    replacement,
    scope: '/root',
    compiled: compiled(variables),
    files: [file],
  });
}

describe('RewriteEngine', () => {
  it('substitutes single and variadic captures deterministically', () => {
    const source = 'foo(a, b);';
    const matches = [
      match(source.slice(0, 9), 0, 9, [{ name: 'ARGS', variadic: true, text: 'a, b' }]),
    ];
    const first = build(source, matches, 'bar(0, $$$ARGS)', [{ name: 'ARGS', variadic: true }]);
    const second = build(source, matches, 'bar(0, $$$ARGS)', [{ name: 'ARGS', variadic: true }]);
    expect(first.files[0]?.output.toString()).toBe('bar(0, a, b);');
    expect(first.candidateId).toBe(second.candidateId);
    expect(first.publicPreview.changes).toHaveLength(1);
  });

  it('rejects missing and wrong-arity replacement captures', () => {
    expect(() => build('foo(x)', [match('foo(x)', 0, 6)], '$MISSING', [])).toThrow(
      RewriteBuildError
    );
    try {
      build('foo(x)', [match('foo(x)', 0, 6)], '$ARGS', [{ name: 'ARGS', variadic: true }]);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AST_REWRITE_CAPTURE_INVALID' });
    }
  });

  it('rejects duplicate, nested, and partially overlapping ranges but accepts adjacency', () => {
    for (const unsafe of [
      [match('abc', 0, 3), match('abc', 0, 3)],
      [match('abcdef', 0, 6), match('bc', 1, 3)],
      [match('abcd', 0, 4), match('def', 3, 6)],
    ]) {
      expect(() => build('abcdef', unsafe, 'wrap()', [])).toThrow(RewriteBuildError);
    }
    const adjacent = build(
      'foo()bar()',
      [match('foo()', 0, 5), match('bar()', 5, 10)],
      'wrap()',
      []
    );
    expect(adjacent.files[0]?.output.toString()).toBe('wrap()wrap()');
  });

  it('returns a zero-write candidate for no-op substitution', () => {
    const result = build(
      'foo(x)',
      [match('foo(x)', 0, 6, [{ name: 'ALL', text: 'foo(x)' }])],
      '$ALL',
      [{ name: 'ALL' }]
    );
    expect(result.files).toEqual([]);
    expect(result.publicPreview).toMatchObject({ changesPlanned: 0, filesMatched: 1 });
  });

  it('bounds preview text without changing the exact prepared output', () => {
    const before = `foo(${'x'.repeat(5_000)})`;
    const result = build(
      before,
      [match(before, 0, before.length, [{ name: 'ALL', text: before }])],
      'wrap(0, $ALL)',
      [{ name: 'ALL' }]
    );
    const change = result.publicPreview.changes[0];
    expect(Buffer.byteLength(change?.before ?? '')).toBe(4_096);
    expect(Buffer.byteLength(change?.after ?? '')).toBe(4_096);
    expect(result.files[0]?.output.toString()).toBe(`wrap(0, ${before})`);
  });

  it('enforces per-file and aggregate output bounds', () => {
    try {
      build('foo()', [match('foo()', 0, 5)], 'x'.repeat(512 * 1024 + 1), []);
      throw new Error('expected file cap rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AST_REWRITE_OUTPUT_OVERSIZED' });
    }

    const files: RewriteSourceFile[] = Array.from({ length: 100 }, (_, index) => {
      const relativePath = `${index}.ts`;
      const source = `foo()${' '.repeat(90_000)}`;
      const exact = { ...match('foo()', 0, 5), file: `/root/${relativePath}` };
      return {
        absolutePath: `/root/${relativePath}`,
        relativePath,
        mode: 0o100644,
        original: Buffer.from(source),
        source,
        matches: [exact],
      };
    });
    try {
      new RewriteEngine().build({
        root: '/root',
        language: 'typescript',
        pattern: 'foo()',
        replacement: 'bar(0)',
        scope: '/root',
        compiled: compiled([]),
        files,
      });
      throw new Error('expected transaction cap rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AST_REWRITE_OUTPUT_OVERSIZED' });
    }
  });

  it('directs identifier-only changes to semantic LSP rename', () => {
    try {
      build('foo(x)', [match('foo(x)', 0, 6)], 'bar(x)', []);
      throw new Error('expected rejection');
    } catch (error) {
      expect(error).toMatchObject({ code: 'AST_REWRITE_SEMANTIC_RENAME' });
      expect(String(error)).toContain('rename_symbol_strict');
    }
    expect(() => build('foo(x)', [match('foo(x)', 0, 6)], 'bar(0, x)', [])).not.toThrow();
  });
});
