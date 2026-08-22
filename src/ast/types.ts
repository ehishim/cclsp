import type Parser from 'web-tree-sitter';
import type { DocumentSymbol, Location, SymbolInformation } from '../lsp/types.js';

export const AST_MAX_FILE_BYTES = 512 * 1024;
export const AST_MAX_FILES = 5_000;
export const AST_DEFAULT_RESULTS = 100;
export const AST_MAX_RESULTS = 1_000;
export const AST_MAX_MATCH_TEXT_BYTES = 4_096;
export const AST_MAX_CAPTURE_TEXT_BYTES = 2_048;
export const AST_TREE_CACHE_FILES = 128;
export const AST_TREE_CACHE_BYTES = 64 * 1024 * 1024;
export const AST_MAX_PATTERN_NODES = 256;
export const AST_MAX_METAVARIABLES = 32;
export const AST_MAX_FAILED_FILES = 20;
export const AST_FALLBACK_DEFINITION_RESULTS = 100;

export const AST_LANGUAGES = [
  'typescript',
  'tsx',
  'javascript',
  'jsx',
  'python',
  'php',
  'go',
  'rust',
  'java',
] as const;

export type AstLanguage = (typeof AST_LANGUAGES)[number];
export type Provider = 'lsp' | 'tree-sitter' | 'none';

export interface AstRange {
  start: { line: number; character: number };
  end: { line: number; character: number };
}

export interface AstCapture {
  name: string;
  range: AstRange;
  text: string;
  variadic: boolean;
}

export interface AstMatch {
  file: string;
  range: AstRange;
  text: string;
  captures: AstCapture[];
}

export interface AstSearchInput {
  pattern: string;
  language: string;
  path?: string;
  maxResults?: number;
}

export interface AstSearchOk {
  outcome: 'ok';
  provider: 'tree-sitter';
  language: AstLanguage;
  matches: AstMatch[];
  truncated: boolean;
  effectiveMaxResults: number;
  filesScanned: number;
  filesSkippedOversized: number;
  indexCapped: boolean;
  partial: boolean;
  parseFailureCount: number;
  failedFiles: Array<{ file: string; code: 'AST_PARSE_FAILED' }>;
}

export type AstErrorCode =
  | 'AST_PATTERN_INVALID'
  | 'AST_PARSE_FAILED'
  | 'AST_FILE_OVERSIZED'
  | 'AST_LANGUAGE_UNSUPPORTED'
  | 'AST_PATH_ESCAPED'
  | 'AST_PATH_INVALID'
  | 'AST_ARGUMENT_INVALID';

export interface AstRejected {
  outcome: 'rejected';
  provider: 'tree-sitter' | 'none';
  code: AstErrorCode;
  reason: string;
  bytes?: number;
  cap?: number;
}

export type AstSearchOutcome = AstSearchOk | AstRejected;

export type ProviderValue<T> =
  | {
      outcome: 'ok';
      provider: 'lsp';
      value: T;
      warning?: string;
      matchedSymbols?: number;
      matchedDescriptions?: string[];
    }
  | {
      outcome: 'ok';
      provider: 'tree-sitter';
      value: T;
      limitations: string[];
      truncated?: boolean;
    }
  | {
      outcome: 'unavailable';
      provider: 'none';
      code: string;
      reason: string;
      method?: string;
      server?: string;
      lspReason?: string;
      fallback?: { code: string; reason: string };
    };

export type ProviderDocumentSymbols = ProviderValue<Array<DocumentSymbol | SymbolInformation>>;
export type ProviderDefinitions = ProviderValue<Location[]>;

export interface IndexedFile {
  absolutePath: string;
  relativePath: string;
  language: AstLanguage;
  bytes: number;
  mtimeMs: number;
}

export interface IndexedDirectory {
  absolutePath: string;
  relativePath: string;
  mtimeNs: bigint;
  entrySignature: string;
}

export interface WorkspaceSnapshot {
  files: readonly IndexedFile[];
  oversizedFiles: readonly IndexedFile[];
  directories: ReadonlyMap<string, IndexedDirectory>;
  capped: boolean;
  generation: number;
}

export interface CachedTree {
  key: string;
  contentHash: string;
  mtimeMs: number;
  bytes: number;
  source: string;
  tree: Parser.Tree;
  lastUsed: number;
}

export interface PatternMetavariable {
  name: string;
  sentinel: string;
  variadic: boolean;
  order: number;
}

export interface CompiledPattern {
  tree: Parser.Tree;
  node: Parser.SyntaxNode;
  metavariables: PatternMetavariable[];
}
