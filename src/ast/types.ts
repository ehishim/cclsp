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
export const AST_MAX_PATTERNS = 10;
export const AST_MAX_FAILED_FILES = 20;
export const AST_FALLBACK_DEFINITION_RESULTS = 100;
export const AST_REWRITE_MAX_CHANGES = 100;
export const AST_REWRITE_MAX_TRANSACTION_BYTES = 16 * 1024 * 1024;
export const AST_REWRITE_GENERATED_SCAN_CHARACTERS = 2_048;
export const AST_REWRITE_PREVIEW_TEXT_BYTES = 4_096;

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

export interface ExactAstCapture extends AstCapture {
  startIndex: number;
  endIndex: number;
}

export interface ExactStructuralMatch {
  file: string;
  startIndex: number;
  endIndex: number;
  range: AstRange;
  matchedText: string;
  captures: ExactAstCapture[];
}

export interface AstPatternReport {
  pattern: string;
  matches: number;
  /**
   * Present only when this pattern contributed nothing. A structural zero and a
   * regex habit that happens to parse are otherwise indistinguishable, so the
   * note carries the parsed node kind: a caller who wrote `a|b` sees it was read
   * as a binary expression, while a genuinely absent name reads as an identifier.
   */
  note?: string;
}

export interface AstSearchInput {
  /** One pattern, or several asked in a single scan. Never alternation syntax. */
  pattern: string | string[];
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
  /** One row per requested pattern, in request order, so a zero among several is attributable. */
  perPattern: AstPatternReport[];
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

export interface AstRewriteInput {
  pattern: string;
  replacement: string;
  language: string;
  path?: string;
  dryRun?: boolean;
  candidateId?: string;
}

export type AstRewriteErrorCode =
  | AstErrorCode
  | 'AST_REWRITE_PREVIEW_REQUIRED'
  | 'AST_REWRITE_STALE'
  | 'AST_REWRITE_CAPTURE_INVALID'
  | 'AST_REWRITE_SEMANTIC_RENAME'
  | 'AST_REWRITE_TARGET_UNSAFE'
  | 'AST_REWRITE_TARGET_DIRTY'
  | 'AST_REWRITE_ENCODING_INVALID'
  | 'AST_REWRITE_REPLACEMENT_INVALID'
  | 'AST_REWRITE_OUTPUT_OVERSIZED'
  | 'AST_REWRITE_CONFLICT'
  | 'AST_REWRITE_TOO_MANY_MATCHES'
  | 'AST_REWRITE_SCOPE_INCOMPLETE'
  | 'AST_REWRITE_TRANSACTION_FAILED';

export interface AstRewriteChange {
  file: string;
  range: AstRange;
  before: string;
  after: string;
}

export interface RewriteRollback {
  attempted: boolean;
  disk: 'not-needed' | 'complete' | 'failed';
  providers: 'not-needed' | 'complete' | 'failed';
  failedFiles: string[];
}

export interface AstRewritePreview {
  outcome: 'ok';
  provider: 'tree-sitter';
  dryRun: true;
  language: AstLanguage;
  candidateId: `sha256:${string}`;
  changes: AstRewriteChange[];
  filesMatched: number;
  filesChanged: number;
  changesPlanned: number;
  effectiveMaxChanges: number;
  totalOriginalBytes: number;
  totalOutputBytes: number;
}

export interface AstRewriteApplied extends Omit<AstRewritePreview, 'dryRun'> {
  dryRun: false;
  filesModified: string[];
  changesApplied: number;
  rollback: RewriteRollback;
}

export interface AstRewriteRejected {
  outcome: 'rejected';
  provider: 'tree-sitter' | 'none';
  isError: true;
  code: AstRewriteErrorCode;
  reason: string;
  rollback?: RewriteRollback;
}

export interface AstRewriteFailed {
  outcome: 'failed';
  provider: 'tree-sitter';
  isError: true;
  code: AstRewriteErrorCode;
  reason: string;
  rollback: RewriteRollback;
}

export type AstRewriteOutcome =
  | AstRewritePreview
  | AstRewriteApplied
  | AstRewriteRejected
  | AstRewriteFailed;

export interface PreparedRewriteEdit {
  startIndex: number;
  endIndex: number;
  before: string;
  after: string;
  range: AstRange;
}

export interface PreparedRewriteFile {
  absolutePath: string;
  relativePath: string;
  mode: number;
  original: Buffer;
  output: Buffer;
  originalSha256: string;
  edits: PreparedRewriteEdit[];
}

export interface PreparedRewrite {
  root: string;
  language: AstLanguage;
  candidateId: `sha256:${string}`;
  files: PreparedRewriteFile[];
  publicPreview: AstRewritePreview;
}

export type PreparedRewriteResult =
  | { outcome: 'prepared'; prepared: PreparedRewrite }
  | AstRewriteRejected;

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
