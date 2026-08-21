import type { LSPClient } from '../lsp-client.js';
import type { DocumentSymbol, Position, SymbolInformation } from '../lsp/types.js';
import type { ToolResult } from './registry.js';

const MAX_RECOVERY_CANDIDATES = 20;

export interface PositionSelector {
  query?: string;
  line?: number;
  character?: number;
}

export interface SymbolCandidate {
  name: string;
  qualifiedName: string;
  kind: string;
  position: Position;
}

export type ToolPositionResolution =
  | { outcome: 'resolved'; position: Position; candidate?: SymbolCandidate; query?: string }
  | { outcome: 'ambiguous'; query: string; candidates: SymbolCandidate[] }
  | { outcome: 'not_found'; query: string; candidates: SymbolCandidate[] }
  | { outcome: 'invalid'; reason: string };

type InternalCandidate = SymbolCandidate;

export async function resolveToolPosition(
  filePath: string,
  selector: PositionSelector,
  client: LSPClient
): Promise<ToolPositionResolution> {
  const hasQuery = typeof selector.query === 'string';
  const hasLine = selector.line !== undefined;
  const hasCharacter = selector.character !== undefined;

  if (hasQuery && (hasLine || hasCharacter)) {
    return { outcome: 'invalid', reason: 'provide query or line/character, not both' };
  }
  if (!hasQuery && (!hasLine || !hasCharacter)) {
    return { outcome: 'invalid', reason: 'either query or both line and character are required' };
  }
  if (!hasQuery) {
    const line = selector.line as number;
    const character = selector.character as number;
    if (!Number.isInteger(line) || !Number.isInteger(character) || line < 1 || character < 1) {
      return { outcome: 'invalid', reason: 'line and character must be positive integers' };
    }
    return { outcome: 'resolved', position: { line: line - 1, character: character - 1 } };
  }

  const query = selector.query?.trim() ?? '';
  if (!query) return { outcome: 'invalid', reason: 'query must not be empty' };

  const symbols = await client.getDocumentSymbols(filePath);
  const candidates = flattenSymbols(symbols, client);
  const queryLower = query.toLowerCase();
  const tiers = [
    (candidate: InternalCandidate) => candidate.name === query || candidate.qualifiedName === query,
    (candidate: InternalCandidate) =>
      candidate.name.toLowerCase() === queryLower ||
      candidate.qualifiedName.toLowerCase() === queryLower,
    (candidate: InternalCandidate) =>
      candidate.name.toLowerCase().includes(queryLower) ||
      candidate.qualifiedName.toLowerCase().includes(queryLower),
  ];

  for (const matchesTier of tiers) {
    const matches = candidates.filter(matchesTier);
    if (matches.length === 1) {
      const candidate = matches[0];
      if (candidate) {
        return { outcome: 'resolved', position: candidate.position, candidate, query };
      }
    }
    if (matches.length > 1) {
      return {
        outcome: 'ambiguous',
        query,
        candidates: matches.slice(0, MAX_RECOVERY_CANDIDATES),
      };
    }
  }

  return {
    outcome: 'not_found',
    query,
    candidates: candidates.slice(0, MAX_RECOVERY_CANDIDATES),
  };
}

export function positionResolutionResult(
  resolution: Exclude<ToolPositionResolution, { outcome: 'resolved' }>,
  filePath: string
): ToolResult {
  if (resolution.outcome === 'invalid') {
    return failureResult(
      'LSP_POSITION_INVALID',
      `Invalid position selector for ${filePath}: ${resolution.reason}`,
      { reason: resolution.reason }
    );
  }

  const candidates = resolution.candidates.map(({ name, qualifiedName, kind, position }) => ({
    name,
    qualifiedName,
    kind,
    line: position.line + 1,
    character: position.character + 1,
  }));
  const rendered = candidates
    .map(
      (candidate) =>
        `- ${candidate.qualifiedName} (${candidate.kind}) at ${candidate.line}:${candidate.character}`
    )
    .join('\n');
  const code = resolution.outcome === 'ambiguous' ? 'LSP_SYMBOL_AMBIGUOUS' : 'LSP_SYMBOL_NOT_FOUND';
  const prefix =
    resolution.outcome === 'ambiguous'
      ? `Symbol query "${resolution.query}" is ambiguous in ${filePath}.`
      : `Symbol query "${resolution.query}" was not found in ${filePath}.`;
  const recovery =
    candidates.length > 0
      ? `\nCandidates (max ${MAX_RECOVERY_CANDIDATES}):\n${rendered}`
      : '\nThe language server returned no document symbols for recovery.';
  return failureResult(code, `${prefix}${recovery}`, {
    query: resolution.query,
    candidates,
  });
}

export function resolvedFromText(resolution: ToolPositionResolution): string | undefined {
  if (resolution.outcome !== 'resolved' || !resolution.candidate) return undefined;
  return `Resolved "${resolution.candidate.qualifiedName}" at ${resolution.position.line + 1}:${resolution.position.character + 1}`;
}

export function resolvedFromMetadata(
  resolution: ToolPositionResolution
): Record<string, unknown> | undefined {
  if (resolution.outcome !== 'resolved' || !resolution.candidate || !resolution.query) {
    return undefined;
  }
  return {
    query: resolution.query,
    name: resolution.candidate.name,
    qualifiedName: resolution.candidate.qualifiedName,
    kind: resolution.candidate.kind,
    line: resolution.position.line + 1,
    character: resolution.position.character + 1,
  };
}

function failureResult(code: string, text: string, extra: Record<string, unknown>): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: ${code}: ${text}` }],
    structuredContent: { outcome: 'rejected', code, ...extra },
    isError: true,
  };
}

function flattenSymbols(
  symbols: DocumentSymbol[] | SymbolInformation[],
  client: LSPClient
): InternalCandidate[] {
  if (symbols.length === 0) return [];
  const first = symbols[0];
  if (first && 'selectionRange' in first) {
    return flattenHierarchical(symbols as DocumentSymbol[], client);
  }
  return (symbols as SymbolInformation[]).map((symbol) => ({
    name: symbol.name,
    qualifiedName: symbol.containerName ? `${symbol.containerName}.${symbol.name}` : symbol.name,
    kind: client.symbolKindToString(symbol.kind),
    position: symbol.location.range.start,
  }));
}

function flattenHierarchical(
  symbols: DocumentSymbol[],
  client: LSPClient,
  parents: string[] = []
): InternalCandidate[] {
  const result: InternalCandidate[] = [];
  for (const symbol of symbols) {
    const path = [...parents, symbol.name];
    result.push({
      name: symbol.name,
      qualifiedName: path.join('.'),
      kind: client.symbolKindToString(symbol.kind),
      position: symbol.selectionRange.start,
    });
    if (symbol.children?.length) {
      result.push(...flattenHierarchical(symbol.children, client, path));
    }
  }
  return result;
}
