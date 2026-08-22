import type Parser from 'web-tree-sitter';
import type { AstRange } from './types.js';

// web-tree-sitter indexes JavaScript string input in UTF-16 code units, matching LSP columns.
export class SourceLocator {
  private readonly lineStartIndices = [0];

  constructor(private readonly source: string) {
    for (let index = 0; index < source.length; index++) {
      if (source.charCodeAt(index) === 10) this.lineStartIndices.push(index + 1);
    }
  }

  text(startIndex: number, endIndex: number): string {
    return this.source.slice(startIndex, endIndex);
  }

  range(node: Parser.SyntaxNode): AstRange {
    return {
      start: { line: node.startPosition.row, character: node.startPosition.column },
      end: { line: node.endPosition.row, character: node.endPosition.column },
    };
  }

  rangeByIndex(startIndex: number, endIndex: number, startLine: number, endLine: number): AstRange {
    return {
      start: { line: startLine, character: this.characterAt(startIndex, startLine) },
      end: { line: endLine, character: this.characterAt(endIndex, endLine) },
    };
  }

  private characterAt(index: number, line: number): number {
    return index - (this.lineStartIndices[line] ?? 0);
  }
}
