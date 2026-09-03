import type { Node as TsNode, Tree as TsTree } from 'web-tree-sitter';
import { SourceLocator } from './source-locator.js';
import {
  AST_MAX_CAPTURE_TEXT_BYTES,
  AST_MAX_MATCH_TEXT_BYTES,
  type AstMatch,
  type CompiledPattern,
  type ExactStructuralMatch,
  type PatternMetavariable,
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

function truncateUtf8(text: string, maxBytes: number): string {
  let bytes = 0;
  let result = '';
  for (const point of text) {
    const width = Buffer.byteLength(point);
    if (bytes + width > maxBytes) break;
    result += point;
    bytes += width;
  }
  return result;
}

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

export class SearchEngine {
  search(
    tree: TsTree,
    source: string,
    compiled: CompiledPattern,
    file: string,
    maxResults: number
  ): AstMatch[] {
    return this.searchExact(tree, source, compiled, file, maxResults).map((match) => ({
      file: match.file,
      range: match.range,
      text: truncateUtf8(match.matchedText, AST_MAX_MATCH_TEXT_BYTES),
      captures: match.captures.map(({ startIndex: _start, endIndex: _end, ...capture }) => ({
        ...capture,
        text: truncateUtf8(capture.text, AST_MAX_CAPTURE_TEXT_BYTES),
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

    const visit = (node: TsNode): void => {
      if (results.length >= maxResults) return;
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
      for (const child of node.namedChildren) visit(child);
    };

    visit(tree.rootNode);
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
