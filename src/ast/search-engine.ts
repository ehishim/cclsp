import type { Node as TsNode, Tree as TsTree } from 'web-tree-sitter';
import { SourceLocator } from './source-locator.js';
import type {
  AstMatch,
  CompiledPattern,
  ExactStructuralMatch,
  PatternMetavariable,
} from './types.js';

interface BoundCapture {
  name: string;
  variadic: boolean;
  startIndex: number;
  endIndex: number;
  startLine: number;
  endLine: number;
  text: string;
  order: number;
}

const IGNORED_ANONYMOUS = new Set(['(', ')', '{', '}', '[', ']', ',', ';', ':']);

function anonymousSignature(node: TsNode): string[] {
  return node.children
    .filter((child) => !child.isNamed && !child.isExtra && !IGNORED_ANONYMOUS.has(child.type))
    .map((child) => child.type);
}

function captureFingerprint(bindings: Map<string, BoundCapture>): string {
  return [...bindings.values()]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((capture) => `${capture.name}:${capture.text}`)
    .join('\u0001');
}

/** Cursor traversal avoids recursive stack growth and child-array allocation. */
function walkNamedNodes(tree: TsTree, visit: (node: TsNode) => boolean): void {
  const cursor = tree.walk();
  try {
    for (;;) {
      const node = cursor.currentNode;
      if (node.isNamed && !visit(node)) return;
      if (cursor.gotoFirstChild()) continue;
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) return;
      }
    }
  } finally {
    cursor.delete();
  }
}

export class SearchEngine {
  search(
    tree: TsTree,
    source: string,
    compiled: CompiledPattern,
    file: string,
    maxResults: number
  ): AstMatch[] {
    // A standalone name asks for name occurrences, not one grammar's identifier
    // subtype. Keep structural rewrite on searchExact's strict node matching.
    if (compiled.metavariables.length === 0 && compiled.node.type === 'identifier') {
      const matches: AstMatch[] = [];
      const locator = new SourceLocator(source);
      const nameKinds = new Set([
        'identifier',
        'property_identifier',
        'field_identifier',
        'type_identifier',
        'shorthand_property_identifier',
        'shorthand_property_identifier_pattern',
      ]);
      walkNamedNodes(tree, (node) => {
        if (matches.length >= maxResults) return false;
        if (nameKinds.has(node.type) && node.text === compiled.node.text) {
          matches.push({ file, range: locator.range(node), text: node.text, captures: [] });
        }
        return matches.length < maxResults;
      });
      return matches;
    }
    return this.searchExact(tree, source, compiled, file, maxResults).map((match) => ({
      file: match.file,
      range: match.range,
      text: match.matchedText,
      captures: match.captures.map(({ startIndex: _start, endIndex: _end, ...capture }) => ({
        ...capture,
        text: capture.text,
      })),
    }));
  }

  searchExact(
    tree: TsTree,
    source: string,
    compiled: CompiledPattern,
    file: string,
    maxResults: number
  ): ExactStructuralMatch[] {
    const results: ExactStructuralMatch[] = [];
    const locator = new SourceLocator(source);
    const variables = new Map(
      compiled.metavariables.map((variable) => [variable.sentinel, variable])
    );

    walkNamedNodes(tree, (node) => {
      if (results.length >= maxResults) return false;
      const bindings = this.matchNode(compiled.node, node, locator, variables, new Map());
      if (bindings) {
        const captures = [...bindings.values()]
          .sort((a, b) => a.order - b.order || a.startIndex - b.startIndex)
          .map((capture) => ({
            name: capture.name,
            variadic: capture.variadic,
            startIndex: capture.startIndex,
            endIndex: capture.endIndex,
            range: locator.rangeByIndex(
              capture.startIndex,
              capture.endIndex,
              capture.startLine,
              capture.endLine
            ),
            text: capture.text,
          }));
        results.push({
          file,
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          range: locator.range(node),
          matchedText: locator.text(node.startIndex, node.endIndex),
          captures,
        });
      }
      return results.length < maxResults;
    });
    return results;
  }

  private matchNode(
    pattern: TsNode,
    sourceNode: TsNode,
    locator: SourceLocator,
    variables: Map<string, PatternMetavariable>,
    bindings: Map<string, BoundCapture>
  ): Map<string, BoundCapture> | undefined {
    const variable = variables.get(pattern.text);
    if (variable && !variable.variadic) {
      return this.bind(
        variable,
        sourceNode.startIndex,
        sourceNode.endIndex,
        sourceNode.startPosition.row,
        sourceNode.endPosition.row,
        locator,
        bindings
      );
    }
    if (variable?.variadic) return undefined;
    if (pattern.type !== sourceNode.type) return undefined;
    if (
      anonymousSignature(pattern).join('\u0000') !== anonymousSignature(sourceNode).join('\u0000')
    ) {
      return undefined;
    }
    if (pattern.namedChildCount === 0) {
      return pattern.text === sourceNode.text ? bindings : undefined;
    }
    return this.matchChildren(pattern, sourceNode, locator, variables, bindings);
  }

  private matchChildren(
    patternParent: TsNode,
    sourceParent: TsNode,
    locator: SourceLocator,
    variables: Map<string, PatternMetavariable>,
    initial: Map<string, BoundCapture>
  ): Map<string, BoundCapture> | undefined {
    const patternChildren = patternParent.namedChildren;
    const sourceChildren = sourceParent.namedChildren;
    const memo = new Set<string>();

    const match = (
      patternIndex: number,
      sourceIndex: number,
      bindings: Map<string, BoundCapture>
    ): Map<string, BoundCapture> | undefined => {
      const memoKey = `${patternIndex}:${sourceIndex}:${captureFingerprint(bindings)}`;
      if (memo.has(memoKey)) return undefined;
      memo.add(memoKey);
      if (patternIndex === patternChildren.length) {
        return sourceIndex === sourceChildren.length ? bindings : undefined;
      }
      const patternChild = patternChildren[patternIndex];
      if (!patternChild) return undefined;
      const variable = variables.get(patternChild.text);
      if (variable?.variadic) {
        for (let end = sourceIndex; end <= sourceChildren.length; end++) {
          const startNode = sourceChildren[sourceIndex];
          const endNode = end > sourceIndex ? sourceChildren[end - 1] : undefined;
          const start = startNode?.startIndex ?? sourceParent.endIndex;
          const startLine = startNode?.startPosition.row ?? sourceParent.endPosition.row;
          const finish = endNode?.endIndex ?? start;
          const endLine = endNode?.endPosition.row ?? startLine;
          const next = this.bind(variable, start, finish, startLine, endLine, locator, bindings);
          if (!next) continue;
          const result = match(patternIndex + 1, end, next);
          if (result) return result;
        }
        return undefined;
      }
      const sourceChild = sourceChildren[sourceIndex];
      if (!sourceChild) return undefined;
      const next = this.matchNode(patternChild, sourceChild, locator, variables, new Map(bindings));
      return next ? match(patternIndex + 1, sourceIndex + 1, next) : undefined;
    };

    return match(0, 0, new Map(initial));
  }

  private bind(
    variable: PatternMetavariable,
    start: number,
    end: number,
    startLine: number,
    endLine: number,
    locator: SourceLocator,
    bindings: Map<string, BoundCapture>
  ): Map<string, BoundCapture> | undefined {
    const text = locator.text(start, end);
    const existing = bindings.get(variable.name);
    if (existing) return existing.text === text ? new Map(bindings) : undefined;
    const next = new Map(bindings);
    next.set(variable.name, {
      name: variable.name,
      variadic: variable.variadic,
      startIndex: start,
      endIndex: end,
      startLine,
      endLine,
      text,
      order: variable.order,
    });
    return next;
  }
}
