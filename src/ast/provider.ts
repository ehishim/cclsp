import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { setImmediate as yieldToEventLoop } from 'node:timers/promises';
import type Parser from 'web-tree-sitter';
import { type Location, SymbolKind } from '../lsp/types.js';
import { pathToUri } from '../utils.js';
import { extractDeclarations } from './declaration-extractor.js';
import { GrammarRegistry } from './grammar-registry.js';
import { PatternCompiler } from './pattern-compiler.js';
import { SearchEngine } from './search-engine.js';
import {
  AST_DEFAULT_RESULTS,
  AST_FALLBACK_DEFINITION_RESULTS,
  AST_LANGUAGES,
  AST_MAX_FAILED_FILES,
  AST_MAX_FILE_BYTES,
  AST_MAX_RESULTS,
  type AstLanguage,
  type AstRejected,
  type AstSearchInput,
  type AstSearchOutcome,
  type CompiledPattern,
  type IndexedFile,
  type ProviderDefinitions,
  type ProviderDocumentSymbols,
} from './types.js';
import { WorkspaceIndex, languageForPath } from './workspace-index.js';

const LIMITATIONS = ['syntax-only', 'no-import-resolution', 'no-overload-resolution'];

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

function rejected(
  provider: AstRejected['provider'],
  code: AstRejected['code'],
  reason: string,
  extra: Pick<AstRejected, 'bytes' | 'cap'> = {}
): AstRejected {
  return { outcome: 'rejected', provider, code, reason, ...extra };
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

    let compiled: CompiledPattern;
    try {
      compiled = await this.compiler.compile(input.pattern, input.language);
    } catch (error) {
      return rejected(
        'tree-sitter',
        'AST_PATTERN_INVALID',
        error instanceof Error ? error.message.replace(/^AST_PATTERN_INVALID:/, '') : String(error)
      );
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
        const remaining = Math.max(1, boundedMaxResults - matches.length + 1);
        const fileMatches = this.searchEngine.search(
          parsed.tree,
          parsed.source,
          compiled,
          file.absolutePath,
          remaining
        );
        matches.push(...fileMatches);
        if (matches.length > boundedMaxResults) {
          truncated = true;
          matches.length = boundedMaxResults;
          break;
        }
        if ((indexInCandidates + 1) % 16 === 0) await yieldToEventLoop();
      }

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
      };
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
