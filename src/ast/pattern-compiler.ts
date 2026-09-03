import type { Node as TsNode, Tree as TsTree } from 'web-tree-sitter';
import type { GrammarRegistry } from './grammar-registry.js';
import {
  AST_MAX_METAVARIABLES,
  AST_MAX_PATTERN_NODES,
  type AstLanguage,
  type CompiledPattern,
  type PatternMetavariable,
} from './types.js';

interface WrappedPattern {
  text: string;
  start: number;
  end: number;
}

const LITERAL_DOLLAR = 'CCLSP_LITERAL_DOLLAR_7F4E';

function indentPython(source: string): string {
  return source
    .split('\n')
    .map((line) => `    ${line}`)
    .join('\n');
}

function wrappers(source: string, language: AstLanguage): WrappedPattern[] {
  const direct = { text: source, start: 0, end: source.length };
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return [direct, { text: `(${source});`, start: 1, end: source.length + 1 }];
    case 'python': {
      const prefix = 'def _():\n';
      const body = indentPython(source);
      return [
        direct,
        { text: `${prefix}${body}`, start: prefix.length + 4, end: prefix.length + body.length },
      ];
    }
    case 'php': {
      const prefix = '<?php ';
      const contextual = {
        text: `${prefix}${source}`,
        start: prefix.length,
        end: prefix.length + source.length,
      };
      return source.trimStart().startsWith('<?php') ? [direct] : [contextual];
    }
    case 'go': {
      const prefix = 'package p; func _(){ ';
      return [
        direct,
        { text: `${prefix}${source} }`, start: prefix.length, end: prefix.length + source.length },
      ];
    }
    case 'rust': {
      const prefix = 'fn _(){ ';
      return [
        direct,
        { text: `${prefix}${source} }`, start: prefix.length, end: prefix.length + source.length },
      ];
    }
    case 'java': {
      const prefix = 'class _ { void _(){ ';
      return [
        direct,
        {
          text: `${prefix}${source} } }`,
          start: prefix.length,
          end: prefix.length + source.length,
        },
      ];
    }
    case 'css': {
      // A CSS fragment is ambiguous on its own, so the order below IS the
      // contract: a complete rule parses directly, then a declaration, then a
      // selector or at-rule prelude, and only then a value fragment. `#fff`
      // compiles as both a selector and a value; the order makes it a selector.
      const declaration = '_{';
      const value = '_{_:';
      // Order is the contract, and it is not arbitrary: `color: var(--x)` parses
      // DIRECTLY as a pseudo-class selector (`tag:pseudo(...)`), which is never
      // what a caller means, so the declaration wrapper must be tried first. A
      // complete rule then still resolves through the direct form.
      return [
        {
          text: `${declaration}${source};}`,
          start: declaration.length,
          end: declaration.length + source.length,
        },
        direct,
        { text: `${source}{}`, start: 0, end: source.length },
        { text: `${value}${source};}`, start: value.length, end: value.length + source.length },
      ];
    }
  }
}

function containsMissing(node: TsNode): boolean {
  if (node.isMissing || node.isError) return true;
  return node.children.some(containsMissing);
}

function countNodes(node: TsNode): number {
  let count = 1;
  for (const child of node.namedChildren) count += countNodes(child);
  return count;
}

function nodeForPattern(tree: TsTree, start: number, end: number): TsNode | undefined {
  if (end <= start) return undefined;
  const node = tree.rootNode.namedDescendantForIndex(start, end - 1);
  if (!node || node.startIndex > start || node.endIndex < end) return undefined;
  return node;
}

export class PatternCompiler {
  constructor(private readonly grammars: GrammarRegistry) {}

  async compile(pattern: string, language: AstLanguage): Promise<CompiledPattern> {
    if (!pattern.trim()) throw new Error('AST_PATTERN_INVALID:pattern must not be empty');
    const variables = new Map<string, PatternMetavariable>();
    const protectedPattern = pattern.replace(/\\\$/g, LITERAL_DOLLAR);
    const rewritten = protectedPattern
      .replace(/\$\$\$([A-Z][A-Z0-9_]*)|\$([A-Z][A-Z0-9_]*)/g, (_match, variadic, single) => {
        const name = (variadic ?? single) as string;
        const isVariadic = variadic !== undefined;
        const existing = variables.get(name);
        if (existing && existing.variadic !== isVariadic) {
          throw new Error(`AST_PATTERN_INVALID:metavariable ${name} uses both arities`);
        }
        if (existing) return existing.sentinel;
        if (variables.size >= AST_MAX_METAVARIABLES) {
          throw new Error(
            `AST_PATTERN_INVALID:at most ${AST_MAX_METAVARIABLES} metavariables are allowed`
          );
        }
        const variable: PatternMetavariable = {
          name,
          sentinel: `CCLSP_${isVariadic ? 'VMETA' : 'META'}_${variables.size}_${name}`,
          variadic: isVariadic,
          order: variables.size,
        };
        variables.set(name, variable);
        return variable.sentinel;
      })
      .replaceAll(LITERAL_DOLLAR, '$');

    for (const wrapped of wrappers(rewritten, language)) {
      const tree = await this.grammars.parse(wrapped.text, language);
      const node = nodeForPattern(tree, wrapped.start, wrapped.end);
      if (
        node &&
        !node.hasError &&
        !containsMissing(node) &&
        countNodes(node) <= AST_MAX_PATTERN_NODES
      ) {
        return { tree, node, metavariables: [...variables.values()] };
      }
      tree.delete();
    }
    throw new Error(`AST_PATTERN_INVALID:pattern does not parse as ${language}`);
  }
}
