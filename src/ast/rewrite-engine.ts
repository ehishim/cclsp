import { createHash } from 'node:crypto';
import {
  AST_MAX_FILE_BYTES,
  AST_REWRITE_MAX_CHANGES,
  AST_REWRITE_MAX_TRANSACTION_BYTES,
  AST_REWRITE_PREVIEW_TEXT_BYTES,
  type AstLanguage,
  type AstRewriteErrorCode,
  type CompiledPattern,
  type ExactStructuralMatch,
  type PreparedRewrite,
  type PreparedRewriteEdit,
  type PreparedRewriteFile,
} from './types.js';

const CANDIDATE_VERSION = 'cclsp-rewrite-v1';

export class RewriteBuildError extends Error {
  constructor(
    readonly code: AstRewriteErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'RewriteBuildError';
  }
}

export interface RewriteSourceFile {
  absolutePath: string;
  relativePath: string;
  mode: number;
  original: Buffer;
  source: string;
  matches: ExactStructuralMatch[];
}

export interface RewriteBuildInput {
  root: string;
  language: AstLanguage;
  pattern: string;
  replacement: string;
  scope: string;
  compiled: CompiledPattern;
  files: RewriteSourceFile[];
}

interface ReplacementReference {
  name: string;
  variadic: boolean;
  raw: string;
}

function replacementReferences(replacement: string): ReplacementReference[] {
  const references: ReplacementReference[] = [];
  const expression = /\\\$|\$\$\$([A-Z][A-Z0-9_]*)|\$([A-Z][A-Z0-9_]*)/g;
  for (const match of replacement.matchAll(expression)) {
    if (match[0] === '\\$') continue;
    const name = match[1] ?? match[2];
    if (name) references.push({ name, variadic: match[1] !== undefined, raw: match[0] });
  }
  return references;
}

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

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function addLengthDelimited(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const buffer = typeof value === 'string' ? Buffer.from(value) : value;
  const length = Buffer.allocUnsafe(8);
  length.writeBigUInt64BE(BigInt(buffer.length));
  hash.update(length);
  hash.update(buffer);
}

function tokenized(text: string): string[] {
  return (
    text.match(
      /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[\p{L}_$][\p{L}\p{N}_$]*|\d+(?:\.\d+)?|[^\s]/gu
    ) ?? []
  );
}

function semanticRenamePair(
  before: string,
  after: string
): { oldName: string; newName: string } | undefined {
  const beforeTokens = tokenized(before);
  const afterTokens = tokenized(after);
  if (beforeTokens.length !== afterTokens.length) return undefined;
  const different: number[] = [];
  for (let index = 0; index < beforeTokens.length; index++) {
    if (beforeTokens[index] !== afterTokens[index]) different.push(index);
  }
  if (different.length !== 1) return undefined;
  const index = different[0];
  if (index === undefined) return undefined;
  const oldName = beforeTokens[index];
  const newName = afterTokens[index];
  const identifier = /^[\p{L}_$][\p{L}\p{N}_$]*$/u;
  return oldName && newName && identifier.test(oldName) && identifier.test(newName)
    ? { oldName, newName }
    : undefined;
}

function validateMatchSet(matches: ExactStructuralMatch[]): ExactStructuralMatch[] {
  const sorted = [...matches].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.startIndex - right.startIndex ||
      left.endIndex - right.endIndex
  );
  for (let index = 1; index < sorted.length; index++) {
    const previous = sorted[index - 1];
    const current = sorted[index];
    if (
      previous &&
      current &&
      previous.file === current.file &&
      current.startIndex < previous.endIndex
    ) {
      throw new RewriteBuildError(
        'AST_REWRITE_CONFLICT',
        `Structural matches overlap or nest in ${current.file}`
      );
    }
  }
  return sorted;
}

function substitute(replacement: string, match: ExactStructuralMatch): string {
  const captures = new Map(match.captures.map((capture) => [capture.name, capture]));
  return replacement.replace(
    /\\\$|\$\$\$([A-Z][A-Z0-9_]*)|\$([A-Z][A-Z0-9_]*)/g,
    (raw, variadic: string | undefined, single: string | undefined) => {
      if (raw === '\\$') return '$';
      const name = variadic ?? single;
      const capture = name ? captures.get(name) : undefined;
      if (!capture) {
        throw new RewriteBuildError(
          'AST_REWRITE_CAPTURE_INVALID',
          `Replacement references missing capture ${raw}`
        );
      }
      return capture.text;
    }
  );
}

function candidateId(input: RewriteBuildInput, files: PreparedRewriteFile[]): `sha256:${string}` {
  const hash = createHash('sha256');
  for (const value of [
    CANDIDATE_VERSION,
    input.root,
    input.language,
    input.pattern,
    input.replacement,
    input.scope,
  ]) {
    addLengthDelimited(hash, value);
  }
  for (const file of files) {
    addLengthDelimited(hash, file.relativePath);
    addLengthDelimited(hash, file.originalSha256);
    addLengthDelimited(hash, String(file.original.length));
    addLengthDelimited(hash, String(file.output.length));
    for (const edit of file.edits) {
      addLengthDelimited(hash, String(edit.startIndex));
      addLengthDelimited(hash, String(edit.endIndex));
      addLengthDelimited(hash, sha256(edit.after));
    }
  }
  return `sha256:${hash.digest('hex')}`;
}

export class RewriteEngine {
  validateReplacementReferences(compiled: CompiledPattern, replacement: string): void {
    const variables = new Map(compiled.metavariables.map((variable) => [variable.name, variable]));
    for (const reference of replacementReferences(replacement)) {
      const variable = variables.get(reference.name);
      if (!variable || variable.variadic !== reference.variadic) {
        throw new RewriteBuildError(
          'AST_REWRITE_CAPTURE_INVALID',
          `Replacement capture ${reference.raw} is missing or uses the wrong arity`
        );
      }
    }
  }

  build(input: RewriteBuildInput): PreparedRewrite {
    this.validateReplacementReferences(input.compiled, input.replacement);
    const allMatches = validateMatchSet(input.files.flatMap((file) => file.matches));
    if (allMatches.length > AST_REWRITE_MAX_CHANGES) {
      throw new RewriteBuildError(
        'AST_REWRITE_TOO_MANY_MATCHES',
        `Structural rewrite found ${allMatches.length} matches; the limit is ${AST_REWRITE_MAX_CHANGES}`
      );
    }

    const preparedFiles: PreparedRewriteFile[] = [];
    const identityFiles: PreparedRewriteFile[] = [];
    const renamePairs: Array<{ oldName: string; newName: string } | undefined> = [];
    let totalOriginalBytes = 0;
    let totalOutputBytes = 0;

    for (const file of [...input.files].sort((a, b) =>
      a.relativePath.localeCompare(b.relativePath)
    )) {
      const edits: PreparedRewriteEdit[] = file.matches
        .map((match) => {
          const after = substitute(input.replacement, match);
          if (after === match.matchedText) return undefined;
          renamePairs.push(semanticRenamePair(match.matchedText, after));
          return {
            startIndex: match.startIndex,
            endIndex: match.endIndex,
            before: match.matchedText,
            after,
            range: match.range,
          };
        })
        .filter((edit): edit is PreparedRewriteEdit => edit !== undefined)
        .sort((a, b) => a.startIndex - b.startIndex || a.endIndex - b.endIndex);
      let output = file.source;
      for (const edit of [...edits].sort((a, b) => b.startIndex - a.startIndex)) {
        output = `${output.slice(0, edit.startIndex)}${edit.after}${output.slice(edit.endIndex)}`;
      }
      const outputBuffer = Buffer.from(output, 'utf8');
      if (outputBuffer.length > AST_MAX_FILE_BYTES) {
        throw new RewriteBuildError(
          'AST_REWRITE_OUTPUT_OVERSIZED',
          `${file.relativePath} would exceed the ${AST_MAX_FILE_BYTES}-byte file limit`
        );
      }
      totalOriginalBytes += file.original.length;
      totalOutputBytes += outputBuffer.length;
      if (totalOriginalBytes + totalOutputBytes > AST_REWRITE_MAX_TRANSACTION_BYTES) {
        throw new RewriteBuildError(
          'AST_REWRITE_OUTPUT_OVERSIZED',
          `Rewrite transaction exceeds ${AST_REWRITE_MAX_TRANSACTION_BYTES} bytes`
        );
      }
      const preparedFile = {
        absolutePath: file.absolutePath,
        relativePath: file.relativePath,
        mode: file.mode,
        original: file.original,
        output: outputBuffer,
        originalSha256: sha256(file.original),
        edits,
      };
      identityFiles.push(preparedFile);
      if (edits.length > 0) preparedFiles.push(preparedFile);
    }

    if (
      renamePairs.length > 0 &&
      renamePairs.every(Boolean) &&
      renamePairs.every(
        (pair) =>
          pair?.oldName === renamePairs[0]?.oldName && pair?.newName === renamePairs[0]?.newName
      )
    ) {
      throw new RewriteBuildError(
        'AST_REWRITE_SEMANTIC_RENAME',
        'This is an identifier-only symbol rename. Use rename_symbol_strict so LSP prepareRename and semantic references own the change.'
      );
    }

    const id = candidateId(input, identityFiles);
    const changes = preparedFiles.flatMap((file) =>
      file.edits.map((edit) => ({
        file: file.absolutePath,
        range: edit.range,
        before: truncateUtf8(edit.before, AST_REWRITE_PREVIEW_TEXT_BYTES),
        after: truncateUtf8(edit.after, AST_REWRITE_PREVIEW_TEXT_BYTES),
      }))
    );
    return {
      root: input.root,
      language: input.language,
      candidateId: id,
      files: preparedFiles,
      publicPreview: {
        outcome: 'ok',
        provider: 'tree-sitter',
        dryRun: true,
        language: input.language,
        candidateId: id,
        changes,
        filesMatched: new Set(allMatches.map((match) => match.file)).size,
        filesChanged: preparedFiles.length,
        changesPlanned: changes.length,
        effectiveMaxChanges: AST_REWRITE_MAX_CHANGES,
        totalOriginalBytes,
        totalOutputBytes,
      },
    };
  }
}
