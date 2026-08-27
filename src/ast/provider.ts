import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, open, realpath, stat } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import { promisify } from 'node:util';
import type Parser from 'web-tree-sitter';
import { type Location, SymbolKind } from '../lsp/types.js';
import { pathToUri } from '../utils.js';
import { extractDeclarations } from './declaration-extractor.js';
import { GrammarRegistry } from './grammar-registry.js';
import { PatternCompiler } from './pattern-compiler.js';
import { RewriteBuildError, RewriteEngine, type RewriteSourceFile } from './rewrite-engine.js';
import { SearchEngine } from './search-engine.js';
import {
  AST_DEFAULT_RESULTS,
  AST_FALLBACK_DEFINITION_RESULTS,
  AST_LANGUAGES,
  AST_MAX_FAILED_FILES,
  AST_MAX_FILE_BYTES,
  AST_MAX_RESULTS,
  AST_REWRITE_GENERATED_SCAN_CHARACTERS,
  AST_REWRITE_MAX_CHANGES,
  type AstLanguage,
  type AstRejected,
  type AstRewriteErrorCode,
  type AstRewriteInput,
  type AstRewriteRejected,
  AST_MAX_PATTERNS,
  type AstPatternReport,
  type AstSearchInput,
  type AstSearchOutcome,
  type CompiledPattern,
  type IndexedFile,
  type PreparedRewrite,
  type PreparedRewriteResult,
  type ProviderDefinitions,
  type ProviderDocumentSymbols,
} from './types.js';
import { WorkspaceIndex, languageForPath } from './workspace-index.js';

const LIMITATIONS = ['syntax-only', 'no-import-resolution', 'no-overload-resolution'];
const execFileAsync = promisify(execFile);
const fatalUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class OversizedFileError extends Error {
  constructor(
    readonly bytes: number,
    readonly cap: number
  ) {
    super(`file exceeds ${cap} bytes`);
  }
}

async function readBoundedSource(path: string): Promise<{ source: string; mtimeMs: number }> {
  const handle = await open(path, 'r');
  try {
    const fileStat = await handle.stat();
    if (fileStat.size > AST_MAX_FILE_BYTES) {
      throw new OversizedFileError(fileStat.size, AST_MAX_FILE_BYTES);
    }
    const chunks: Buffer[] = [];
    let bytes = 0;
    let chunkSize = Math.min(64 * 1024, Math.max(1, fileStat.size + 1));
    while (bytes <= AST_MAX_FILE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, AST_MAX_FILE_BYTES + 1 - bytes));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, bytes);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      bytes += bytesRead;
      if (bytesRead === chunk.length) chunkSize = Math.min(64 * 1024, chunkSize * 2);
    }
    if (bytes > AST_MAX_FILE_BYTES) {
      throw new OversizedFileError(bytes, AST_MAX_FILE_BYTES);
    }
    return { source: Buffer.concat(chunks, bytes).toString('utf8'), mtimeMs: fileStat.mtimeMs };
  } finally {
    await handle.close();
  }
}

/**
 * A structural zero and a regex habit that happens to parse are the same output.
 * `a|b` is a valid bitwise-or expression, so it is never refused as malformed,
 * matches nothing, and reads as absence. Naming the parsed node kind separates
 * the two: `binary_expression` reveals the mistake, while a bare `identifier`
 * that is simply not there stays a plain, unaccused true negative.
 */
function zeroMatchNote(nodeKind: string, patternCount: number): string | undefined {
  if (nodeKind === 'identifier') return undefined;
  const parsed = `parsed as ${nodeKind} and matched structurally; regex syntax is not interpreted here`;
  return patternCount > 1
    ? `${parsed}. Each name is already its own --pattern, so alternation is never needed`
    : `${parsed}. To search several names, pass --pattern once per name`;
}

function rejected(
  provider: AstRejected['provider'],
  code: AstRejected['code'],
  reason: string,
  extra: Pick<AstRejected, 'bytes' | 'cap'> = {}
): AstRejected {
  return { outcome: 'rejected', provider, code, reason, ...extra };
}

function rewriteRejected(
  provider: AstRewriteRejected['provider'],
  code: AstRewriteErrorCode,
  reason: string
): AstRewriteRejected {
  return { outcome: 'rejected', provider, isError: true, code, reason };
}

async function readRewriteSource(path: string): Promise<{
  original: Buffer;
  source: string;
  mode: number;
}> {
  const [canonical, pathStat] = await Promise.all([realpath(path), lstat(path)]);
  if (canonical !== path || pathStat.isSymbolicLink() || !pathStat.isFile()) {
    throw new Error('AST_REWRITE_TARGET_UNSAFE:not a canonical regular file');
  }
  const handle = await open(path, 'r');
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error('AST_REWRITE_TARGET_UNSAFE:not a regular file');
    if (fileStat.size > AST_MAX_FILE_BYTES) {
      throw new OversizedFileError(fileStat.size, AST_MAX_FILE_BYTES);
    }
    const original = Buffer.alloc(fileStat.size);
    let offset = 0;
    while (offset < original.length) {
      const { bytesRead } = await handle.read(original, offset, original.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    if (offset !== original.length) {
      throw new Error('AST_REWRITE_TARGET_UNSAFE:file changed while being read');
    }
    let source: string;
    try {
      source = fatalUtf8.decode(original);
    } catch {
      throw new Error('AST_REWRITE_ENCODING_INVALID:file is not valid UTF-8');
    }
    const header = source.slice(0, AST_REWRITE_GENERATED_SCAN_CHARACTERS);
    if (/@generated/i.test(header) || /^.*Code generated .*DO NOT EDIT.*$/im.test(header)) {
      throw new Error('AST_REWRITE_TARGET_UNSAFE:generated files cannot be rewritten');
    }
    return { original, source, mode: fileStat.mode };
  } finally {
    await handle.close();
  }
}

async function rejectDirtyFiles(root: string, relativePaths: string[]): Promise<void> {
  if (relativePaths.length === 0) return;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-z', '--', ...relativePaths],
      { cwd: root, encoding: 'buffer', maxBuffer: 1024 * 1024 }
    );
    if (stdout.length > 0) {
      throw new Error('AST_REWRITE_TARGET_DIRTY:matched files have Git changes');
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('AST_REWRITE_TARGET_DIRTY:'))
      throw error;
    const stderr = String((error as { stderr?: unknown }).stderr ?? '');
    if (/not a git repository/i.test(stderr)) return;
    throw new Error(`AST_REWRITE_TARGET_UNSAFE:unable to verify Git state: ${String(error)}`);
  }
}

function isAstLanguage(value: string): value is AstLanguage {
  return (AST_LANGUAGES as readonly string[]).includes(value);
}

function normalizeKind(kind: string): string {
  return kind.toLowerCase().replaceAll(/[^a-z]/g, '');
}

export class AstProvider {
  private readonly grammars = new GrammarRegistry();
  private readonly compiler = new PatternCompiler(this.grammars);
  private readonly searchEngine = new SearchEngine();
  private readonly rewriteEngine = new RewriteEngine();
  private readonly indexPromise: Promise<WorkspaceIndex>;

  constructor(root = process.cwd()) {
    this.indexPromise = WorkspaceIndex.create(root);
  }

  async search(input: AstSearchInput): Promise<AstSearchOutcome> {
    if (!isAstLanguage(input.language)) {
      return rejected(
        'none',
        'AST_LANGUAGE_UNSUPPORTED',
        `Unsupported AST language: ${input.language}`
      );
    }
    const effectiveMaxResults = input.maxResults ?? AST_DEFAULT_RESULTS;
    if (!Number.isInteger(effectiveMaxResults) || effectiveMaxResults < 1) {
      return rejected('none', 'AST_ARGUMENT_INVALID', 'max_results must be a positive integer');
    }
    const boundedMaxResults = Math.min(effectiveMaxResults, AST_MAX_RESULTS);
    const index = await this.indexPromise;
    let scope: string;
    try {
      scope = await index.resolveSearchPath(input.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return message.startsWith('AST_PATH_ESCAPED:')
        ? rejected('none', 'AST_PATH_ESCAPED', message.slice('AST_PATH_ESCAPED:'.length))
        : rejected('none', 'AST_PATH_INVALID', message.replace(/^AST_PATH_INVALID:/, ''));
    }

    const requestedPatterns = Array.isArray(input.pattern) ? input.pattern : [input.pattern];
    if (requestedPatterns.length === 0) {
      return rejected('none', 'AST_ARGUMENT_INVALID', 'at least one pattern is required');
    }
    if (requestedPatterns.length > AST_MAX_PATTERNS) {
      return rejected(
        'none',
        'AST_ARGUMENT_INVALID',
        `at most ${AST_MAX_PATTERNS} patterns may be searched in one call`
      );
    }

    const compiledPatterns: CompiledPattern[] = [];
    for (let patternIndex = 0; patternIndex < requestedPatterns.length; patternIndex++) {
      const raw = requestedPatterns[patternIndex];
      if (typeof raw !== 'string') {
        for (const done of compiledPatterns) done.tree.delete();
        return rejected('none', 'AST_ARGUMENT_INVALID', 'every pattern must be a string');
      }
      try {
        compiledPatterns.push(await this.compiler.compile(raw, input.language));
      } catch (error) {
        for (const done of compiledPatterns) done.tree.delete();
        const reason =
          error instanceof Error
            ? error.message.replace(/^AST_PATTERN_INVALID:/, '')
            : String(error);
        // With several patterns supplied, a bare reason cannot be acted on: the
        // caller cannot tell which of them the parser refused.
        return rejected(
          'tree-sitter',
          'AST_PATTERN_INVALID',
          requestedPatterns.length === 1
            ? reason
            : `pattern ${patternIndex + 1} of ${requestedPatterns.length} (${raw}): ${reason}`
        );
      }
    }

    try {
      const scopeStat = await stat(scope);
      const explicitFile = scopeStat.isFile();
      let candidates: IndexedFile[];
      let filesSkippedOversized = 0;
      let indexCapped = false;
      if (scopeStat.isFile()) {
        const language = languageForPath(scope);
        if (!language || !this.languageMatches(language, input.language)) {
          return rejected(
            'none',
            'AST_PATH_INVALID',
            'Requested file does not match the requested language'
          );
        }
        if (scopeStat.size > AST_MAX_FILE_BYTES) {
          return rejected(
            'tree-sitter',
            'AST_FILE_OVERSIZED',
            'Requested file exceeds the AST file cap',
            {
              bytes: scopeStat.size,
              cap: AST_MAX_FILE_BYTES,
            }
          );
        }
        candidates = [
          {
            absolutePath: scope,
            relativePath: scope,
            language,
            bytes: scopeStat.size,
            mtimeMs: scopeStat.mtimeMs,
          },
        ];
      } else if (scopeStat.isDirectory()) {
        const snapshot = await index.ensure();
        candidates = index.allFilesFor(snapshot, scope, input.language);
        indexCapped = snapshot.capped;
      } else {
        return rejected('none', 'AST_PATH_INVALID', 'AST path must be a file or directory');
      }

      const matches = [];
      const perPatternCounts: number[] = new Array(compiledPatterns.length).fill(0);
      const failedFiles: Array<{ file: string; code: 'AST_PARSE_FAILED' }> = [];
      let parseFailureCount = 0;
      let filesScanned = 0;
      let truncated = false;

      for (let indexInCandidates = 0; indexInCandidates < candidates.length; indexInCandidates++) {
        const file = candidates[indexInCandidates];
        if (!file) continue;
        let parsed: { tree: Parser.Tree; source: string };
        try {
          parsed = await this.getFreshTree(index, file, input.language);
          if (parsed.tree.rootNode.hasError) throw new Error('source tree contains parse errors');
        } catch (error) {
          if (error instanceof OversizedFileError) {
            if (explicitFile) {
              return rejected(
                'tree-sitter',
                'AST_FILE_OVERSIZED',
                'Requested file exceeds the AST file cap',
                { bytes: error.bytes, cap: error.cap }
              );
            }
            filesSkippedOversized++;
            continue;
          }
          parseFailureCount++;
          if (explicitFile) {
            return rejected(
              'tree-sitter',
              'AST_PARSE_FAILED',
              `Failed to parse ${file.absolutePath}`
            );
          }
          if (failedFiles.length < AST_MAX_FAILED_FILES) {
            failedFiles.push({ file: file.absolutePath, code: 'AST_PARSE_FAILED' });
          }
          continue;
        }
        filesScanned++;
        for (let patternIndex = 0; patternIndex < compiledPatterns.length; patternIndex++) {
          const compiled = compiledPatterns[patternIndex];
          if (!compiled) continue;
          const alreadyFound = perPatternCounts[patternIndex] ?? 0;
          // Each pattern carries its own budget. Sharing one would let a prolific
          // pattern exhaust the cap and leave a later one reported as absent,
          // manufacturing the false zero this search exists to make impossible.
          if (alreadyFound > boundedMaxResults) continue;
          const remaining = Math.max(1, boundedMaxResults - alreadyFound + 1);
          const fileMatches = this.searchEngine.search(
            parsed.tree,
            parsed.source,
            compiled,
            file.absolutePath,
            remaining
          );
          if (fileMatches.length === 0) continue;
          perPatternCounts[patternIndex] = alreadyFound + fileMatches.length;
          const storable = Math.max(0, boundedMaxResults - matches.length);
          if (fileMatches.length > storable) truncated = true;
          if (storable > 0) matches.push(...fileMatches.slice(0, storable));
        }
        // Stopping early is only safe once every pattern has proven itself
        // present: a pattern still at zero must be scanned to exhaustion, or its
        // zero would report the end of the budget rather than the end of the code.
        if (matches.length >= boundedMaxResults && perPatternCounts.every((count) => count > 0)) {
          break;
        }
        if ((indexInCandidates + 1) % 16 === 0) await yieldToEventLoop();
      }

      const perPattern: AstPatternReport[] = requestedPatterns.map((raw, patternIndex) => {
        const found = Math.min(perPatternCounts[patternIndex] ?? 0, boundedMaxResults);
        const compiled = compiledPatterns[patternIndex];
        const note =
          found === 0 && compiled && compiled.metavariables.length === 0
            ? zeroMatchNote(compiled.node.type, requestedPatterns.length)
            : undefined;
        return note !== undefined
          ? { pattern: String(raw), matches: found, note }
          : { pattern: String(raw), matches: found };
      });

      return {
        outcome: 'ok',
        provider: 'tree-sitter',
        language: input.language,
        matches,
        truncated,
        effectiveMaxResults: boundedMaxResults,
        filesScanned,
        filesSkippedOversized,
        indexCapped,
        partial: parseFailureCount > 0,
        parseFailureCount,
        failedFiles,
        perPattern,
      };
    } finally {
      for (const compiled of compiledPatterns) compiled.tree.delete();
    }
  }

  async prepareRewrite(input: AstRewriteInput): Promise<PreparedRewriteResult> {
    if (!isAstLanguage(input.language)) {
      return rewriteRejected(
        'none',
        'AST_LANGUAGE_UNSUPPORTED',
        `Unsupported AST language: ${input.language}`
      );
    }
    if (typeof input.pattern !== 'string' || typeof input.replacement !== 'string') {
      return rewriteRejected(
        'none',
        'AST_ARGUMENT_INVALID',
        'pattern and replacement must be strings'
      );
    }
    const index = await this.indexPromise;
    let scope: string;
    try {
      scope = await index.resolveRewritePath(input.path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.startsWith('AST_PATH_ESCAPED:')) {
        return rewriteRejected(
          'none',
          'AST_PATH_ESCAPED',
          message.slice('AST_PATH_ESCAPED:'.length)
        );
      }
      if (message.startsWith('AST_REWRITE_TARGET_UNSAFE:')) {
        return rewriteRejected(
          'none',
          'AST_REWRITE_TARGET_UNSAFE',
          message.slice('AST_REWRITE_TARGET_UNSAFE:'.length)
        );
      }
      return rewriteRejected('none', 'AST_PATH_INVALID', message.replace(/^AST_PATH_INVALID:/, ''));
    }

    let compiled: CompiledPattern;
    try {
      compiled = await this.compiler.compile(input.pattern, input.language);
    } catch (error) {
      return rewriteRejected(
        'tree-sitter',
        'AST_PATTERN_INVALID',
        error instanceof Error ? error.message.replace(/^AST_PATTERN_INVALID:/, '') : String(error)
      );
    }

    try {
      try {
        this.rewriteEngine.validateReplacementReferences(compiled, input.replacement);
      } catch (error) {
        if (error instanceof RewriteBuildError) {
          return rewriteRejected('tree-sitter', error.code, error.message);
        }
        throw error;
      }
      let selection: Awaited<ReturnType<WorkspaceIndex['getRewriteFiles']>>;
      try {
        selection = await index.getRewriteFiles(scope, input.language);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rewriteRejected(
          'none',
          message.startsWith('AST_REWRITE_TARGET_UNSAFE:')
            ? 'AST_REWRITE_TARGET_UNSAFE'
            : 'AST_PATH_INVALID',
          message.replace(/^AST_[A-Z_]+:/, '')
        );
      }
      if (selection.capped) {
        return rewriteRejected(
          'tree-sitter',
          'AST_REWRITE_SCOPE_INCOMPLETE',
          'Workspace index is capped; narrow the rewrite scope before applying changes'
        );
      }

      const sourceFiles: RewriteSourceFile[] = [];
      let matchCount = 0;
      for (const file of selection.files) {
        let read: Awaited<ReturnType<typeof readRewriteSource>>;
        try {
          read = await readRewriteSource(file.absolutePath);
        } catch (error) {
          if (error instanceof OversizedFileError) {
            return rewriteRejected(
              'tree-sitter',
              selection.explicitFile ? 'AST_FILE_OVERSIZED' : 'AST_REWRITE_SCOPE_INCOMPLETE',
              selection.explicitFile
                ? `${file.relativePath} exceeds the AST file cap`
                : `Scope includes oversized file ${file.relativePath}`
            );
          }
          const message = error instanceof Error ? error.message : String(error);
          const code = message.startsWith('AST_REWRITE_ENCODING_INVALID:')
            ? 'AST_REWRITE_ENCODING_INVALID'
            : 'AST_REWRITE_TARGET_UNSAFE';
          return rewriteRejected('tree-sitter', code, message.replace(/^AST_[A-Z_]+:/, ''));
        }

        const tree = await this.grammars.parse(read.source, input.language);
        try {
          if (tree.rootNode.hasError) {
            return rewriteRejected(
              'tree-sitter',
              selection.explicitFile ? 'AST_PARSE_FAILED' : 'AST_REWRITE_SCOPE_INCOMPLETE',
              `Source parse failed for ${file.relativePath}`
            );
          }
          const remaining = AST_REWRITE_MAX_CHANGES - matchCount + 1;
          const matches = this.searchEngine.searchExact(
            tree,
            read.source,
            compiled,
            file.absolutePath,
            Math.max(1, remaining)
          );
          matchCount += matches.length;
          if (matchCount > AST_REWRITE_MAX_CHANGES) {
            return rewriteRejected(
              'tree-sitter',
              'AST_REWRITE_TOO_MANY_MATCHES',
              `Structural rewrite exceeds ${AST_REWRITE_MAX_CHANGES} changes`
            );
          }
          if (matches.length > 0) {
            sourceFiles.push({
              absolutePath: file.absolutePath,
              relativePath: file.relativePath,
              mode: read.mode,
              original: read.original,
              source: read.source,
              matches,
            });
          }
        } finally {
          tree.delete();
        }
      }

      try {
        await rejectDirtyFiles(index.root, sourceFiles.map((file) => file.relativePath).sort());
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return rewriteRejected(
          'tree-sitter',
          message.startsWith('AST_REWRITE_TARGET_DIRTY:')
            ? 'AST_REWRITE_TARGET_DIRTY'
            : 'AST_REWRITE_TARGET_UNSAFE',
          message.replace(/^AST_[A-Z_]+:/, '')
        );
      }

      let prepared: PreparedRewrite;
      try {
        prepared = this.rewriteEngine.build({
          root: index.root,
          language: input.language,
          pattern: input.pattern,
          replacement: input.replacement,
          scope,
          compiled,
          files: sourceFiles,
        });
      } catch (error) {
        if (error instanceof RewriteBuildError) {
          return rewriteRejected('tree-sitter', error.code, error.message);
        }
        throw error;
      }

      for (const file of prepared.files) {
        const output = fatalUtf8.decode(file.output);
        const tree = await this.grammars.parse(output, input.language);
        try {
          if (tree.rootNode.hasError) {
            return rewriteRejected(
              'tree-sitter',
              'AST_REWRITE_REPLACEMENT_INVALID',
              `Replacement produces invalid ${input.language} in ${file.relativePath}`
            );
          }
        } finally {
          tree.delete();
        }
      }
      return { outcome: 'prepared', prepared };
    } finally {
      compiled.tree.delete();
    }
  }

  async documentSymbols(file: string): Promise<ProviderDocumentSymbols> {
    const index = await this.indexPromise;
    let canonical: string;
    try {
      canonical = await index.resolveSearchPath(file);
    } catch (error) {
      return {
        outcome: 'unavailable',
        provider: 'none',
        code: 'AST_PATH_INVALID',
        reason: String(error),
      };
    }
    const language = languageForPath(canonical);
    if (!language) {
      return {
        outcome: 'unavailable',
        provider: 'none',
        code: 'AST_LANGUAGE_UNSUPPORTED',
        reason: `No AST grammar for ${canonical}`,
      };
    }
    const fileStat = await stat(canonical);
    if (fileStat.size > AST_MAX_FILE_BYTES) {
      return {
        outcome: 'unavailable',
        provider: 'none',
        code: 'AST_FILE_OVERSIZED',
        reason: `${canonical} exceeds ${AST_MAX_FILE_BYTES} bytes`,
      };
    }
    try {
      const parsed = await this.getFreshTree(
        index,
        {
          absolutePath: canonical,
          relativePath: canonical,
          language,
          bytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        },
        language
      );
      if (parsed.tree.rootNode.hasError) throw new Error('source tree contains parse errors');
      return {
        outcome: 'ok',
        provider: 'tree-sitter',
        value: extractDeclarations(parsed.tree, parsed.source, language),
        limitations: LIMITATIONS,
      };
    } catch (error) {
      return {
        outcome: 'unavailable',
        provider: 'none',
        code: error instanceof OversizedFileError ? 'AST_FILE_OVERSIZED' : 'AST_PARSE_FAILED',
        reason: String(error),
      };
    }
  }

  async findDeclarations(file: string, name: string, kind?: string): Promise<ProviderDefinitions> {
    const index = await this.indexPromise;
    let canonical: string;
    try {
      canonical = await index.resolveSearchPath(file);
    } catch (error) {
      return {
        outcome: 'unavailable',
        provider: 'none',
        code: 'AST_PATH_INVALID',
        reason: String(error),
      };
    }
    const language = languageForPath(canonical);
    if (!language) {
      return {
        outcome: 'unavailable',
        provider: 'none',
        code: 'AST_LANGUAGE_UNSUPPORTED',
        reason: `No AST grammar for ${canonical}`,
      };
    }
    const snapshot = await index.ensure();
    const candidates = index.allFilesFor(snapshot, index.root, language);
    const locations: Location[] = [];
    let truncated = false;
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex++) {
      const fileEntry = candidates[candidateIndex];
      if (!fileEntry) continue;
      try {
        const parsed = await this.getFreshTree(index, fileEntry, language);
        if (parsed.tree.rootNode.hasError) continue;
        const visit = (symbols: ReturnType<typeof extractDeclarations>): void => {
          for (const symbol of symbols) {
            const kindName = normalizeKind(SymbolKind[symbol.kind] ?? String(symbol.kind));
            const requestedKind = kind ? normalizeKind(kind) : undefined;
            if (symbol.name === name && (!requestedKind || kindName === requestedKind)) {
              locations.push({
                uri: pathToUri(fileEntry.absolutePath),
                range: symbol.selectionRange,
              });
              if (locations.length > AST_FALLBACK_DEFINITION_RESULTS) {
                truncated = true;
                return;
              }
            }
            if (symbol.children) visit(symbol.children);
            if (truncated) return;
          }
        };
        visit(extractDeclarations(parsed.tree, parsed.source, language));
      } catch {
        continue;
      }
      if (truncated) break;
      if ((candidateIndex + 1) % 16 === 0) await yieldToEventLoop();
    }
    return {
      outcome: 'ok',
      provider: 'tree-sitter',
      value: locations.slice(0, AST_FALLBACK_DEFINITION_RESULTS),
      limitations: LIMITATIONS,
      truncated: truncated || snapshot.capped,
    };
  }

  async invalidate(path: string): Promise<void> {
    (await this.indexPromise).invalidate(path);
  }

  async dispose(): Promise<void> {
    (await this.indexPromise).dispose();
    this.grammars.dispose();
  }

  private languageMatches(file: AstLanguage, requested: AstLanguage): boolean {
    return file === requested;
  }

  private async getFreshTree(
    index: WorkspaceIndex,
    file: IndexedFile,
    language: AstLanguage
  ): Promise<{ tree: Parser.Tree; source: string }> {
    const current = await readBoundedSource(file.absolutePath);
    const { source } = current;
    const contentHash = createHash('sha256').update(source).digest('hex');
    const cached = index.getCachedTree(file.absolutePath, language, contentHash);
    if (cached) return cached;
    const tree = await this.grammars.parse(source, language);
    return index.setCachedTree(
      {
        path: file.absolutePath,
        contentHash,
        mtimeMs: current.mtimeMs,
        bytes: Buffer.byteLength(source),
        source,
        tree,
      },
      language
    );
  }
}
