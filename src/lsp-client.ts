import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { Stats } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { dirname, extname, isAbsolute, join, normalize, relative, sep } from 'node:path';
import { AstProvider } from './ast/provider.js';
import type {
  AstRewriteInput,
  AstRewriteOutcome,
  AstSearchInput,
  AstSearchOutcome,
  ProviderDefinitions,
  ProviderDocumentSymbols,
  ProviderValue,
} from './ast/types.js';
import { type AtomicRewriteStage, applyAtomicRewrite } from './file-editor.js';
import { loadGitignore, scanDirectoryForExtensions } from './file-scanner.js';
import { logger } from './logger.js';
import { LspToolOutcomeError, supportsMethod } from './lsp/capabilities.js';
import { loadConfig } from './lsp/config.js';
import {
  contentSignature,
  getValidSymbolKinds,
  didRenameFiles as opsDidRenameFiles,
  didRenameFilesBatch as opsDidRenameFilesBatch,
  findDefinition as opsFindDefinition,
  findImplementation as opsFindImplementation,
  findReferences as opsFindReferences,
  findSymbolsByName as opsFindSymbolsByName,
  findTypeDefinition as opsFindTypeDefinition,
  getCodeActions as opsGetCodeActions,
  getCompletions as opsGetCompletions,
  getDiagnostics as opsGetDiagnostics,
  getDiagnosticsBatch as opsGetDiagnosticsBatch,
  getDiagnosticsReport as opsGetDiagnosticsReport,
  getDocumentSymbols as opsGetDocumentSymbols,
  getSignatureHelp as opsGetSignatureHelp,
  hover as opsHover,
  hoverBatch as opsHoverBatch,
  incomingCalls as opsIncomingCalls,
  matchSymbolsByName as opsMatchSymbolsByName,
  outgoingCalls as opsOutgoingCalls,
  prepareCallHierarchy as opsPrepareCallHierarchy,
  renameSymbol as opsRenameSymbol,
  resolveCodeAction as opsResolveCodeAction,
  resolveCompletionItem as opsResolveCompletionItem,
  willRenameFiles as opsWillRenameFiles,
  willRenameFilesBatch as opsWillRenameFilesBatch,
  workspaceSymbol as opsWorkspaceSymbol,
  stringToSymbolKind,
  symbolKindToString,
} from './lsp/operations.js';
import type {
  BatchDiagnosticResult,
  CodeActionResult,
  CompletionItemResult,
  CompletionResult,
  FileRenamePair,
  RenameOperationOptions,
  RenameOperationResult,
  SignatureHelpResult,
  WorkspaceEditResult,
} from './lsp/operations.js';
import { ServerManager } from './lsp/server-manager.js';
import { SymbolKind } from './lsp/types.js';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Config,
  Diagnostic,
  DocumentSymbol,
  LSPServerConfig,
  Location,
  Position,
  ServerState,
  SymbolInformation,
  SymbolMatch,
} from './lsp/types.js';
import { pathToUri, uriToPath } from './utils.js';

const MAX_QUERY_OCCURRENCES = 32;
/** Bound on confirming one project/index is loaded; priming can never hang. */
const WORKSPACE_SYMBOL_READY_BUDGET_MS = 30000;

export interface SymbolQueryMatchResult {
  matches: SymbolMatch[];
  warning?: string;
  incomplete?: boolean;
}

class NoConfiguredLanguageServerError extends Error {
  constructor(readonly filePath: string) {
    super(`No LSP server configured for file: ${filePath}`);
    this.name = 'NoConfiguredLanguageServerError';
  }
}

function isAstFallbackEligible(error: unknown): boolean {
  return (
    error instanceof NoConfiguredLanguageServerError ||
    (error instanceof LspToolOutcomeError && error.outcome.code === 'LSP_METHOD_UNSUPPORTED')
  );
}

function preserveUnsupportedOrigin<T>(
  error: unknown,
  fallback: ProviderValue<T>
): ProviderValue<T> {
  if (!(error instanceof LspToolOutcomeError) || fallback.outcome === 'ok') return fallback;
  return {
    outcome: 'unavailable',
    provider: 'none',
    code: error.outcome.code,
    reason: error.message,
    method: error.outcome.method,
    server: error.outcome.server,
    ...(error.outcome.reason ? { lspReason: error.outcome.reason } : {}),
    fallback: { code: fallback.code, reason: fallback.reason },
  };
}

export class LSPClient {
  private config: Config;
  private serverManager = new ServerManager();
  private astProvider: AstProvider;
  /** One seed per source directory; on a last-document-scoped server each selects a query scope. */
  private workspaceSymbolSeeds = new WeakMap<ServerState, string[]>();
  /** Per-server chain that keeps touch-then-ask pairs from interleaving. */
  private workspaceSymbolScopeTail = new WeakMap<ServerState, Promise<void>>();
  private workspaceSymbolConfirmedServers = new WeakSet<ServerState>();
  private workspaceSymbolConfirmInFlight = new WeakMap<ServerState, Promise<boolean>>();
  /** Configured providers that matched source but failed to preload. */
  private workspaceSymbolUnavailableServers = new Set<string>();
  private workspaceSymbolRecovery: Promise<void> | null = null;
  private rewriteApplyTail: Promise<void> = Promise.resolve();

  constructor(configPath?: string, root = process.cwd()) {
    this.config = loadConfig(configPath);
    this.astProvider = new AstProvider(root);
  }

  private getServerForFile(filePath: string): LSPServerConfig | null {
    const extension = filePath.split('.').pop();
    if (!extension) return null;

    logger.debug(`Looking for server for extension: ${extension}\n`);
    logger.debug(
      `Available servers: ${this.config.servers.map((s) => s.extensions.join(',')).join(' | ')}\n`
    );

    // Find all servers that support this extension
    const matchingServers = this.config.servers.filter((server) =>
      server.extensions.includes(extension)
    );

    if (matchingServers.length === 0) {
      logger.debug(`No server found for extension: ${extension}\n`);
      return null;
    }

    // If only one server matches, use it
    if (matchingServers.length === 1) {
      const server = matchingServers[0];
      if (server) {
        logger.debug(`Found server for ${extension}: ${server.command.join(' ')}\n`);
      }
      return server || null;
    }

    // Multiple servers match - pick the one with most specific rootDir
    // Check if filePath is already absolute (Unix: /, Windows: C:\ or UNC paths)
    const isAbsolutePath =
      filePath.startsWith('/') || filePath.startsWith('\\') || /^[a-zA-Z]:/.test(filePath);
    const absoluteFilePath = normalize(isAbsolutePath ? filePath : join(process.cwd(), filePath));
    let bestMatch: LSPServerConfig | null = null;
    let longestRootLength = -1;

    for (const server of matchingServers) {
      // Normalize rootDir to use platform-specific separators
      // rootDir might be stored with '/' separators even on Windows
      const normalizedServerRoot = server.rootDir ? normalize(server.rootDir) : '.';
      const isAbsolute =
        normalizedServerRoot.startsWith('/') || /^[a-zA-Z]:/.test(normalizedServerRoot);
      const rootDir = normalize(
        isAbsolute ? normalizedServerRoot : join(process.cwd(), normalizedServerRoot)
      );

      const rel = relative(rootDir, absoluteFilePath);

      // File is inside rootDir if relative path doesn't escape with '..'
      // Works on both Unix and Windows (normalize handles path separators)
      if (!rel.startsWith('..')) {
        if (rootDir.length > longestRootLength) {
          longestRootLength = rootDir.length;
          bestMatch = server;
        }
      }
    }

    // Fallback to first match if no rootDir contains the file
    const server = bestMatch || matchingServers[0];

    if (server) {
      logger.debug(
        `Found server for ${extension}: ${server.command.join(' ')} (rootDir: ${server.rootDir || '.'})\n`
      );
    }

    return server || null;
  }

  /**
   * Manually restart LSP servers for specific extensions or all servers
   * @param extensions Array of file extensions, or null to restart all
   * @returns Object with success status and details about restarted servers
   */
  async restartServers(extensions?: string[]): Promise<{
    success: boolean;
    restarted: string[];
    failed: string[];
    message: string;
  }> {
    const restarted: string[] = [];
    const failed: string[] = [];

    logger.debug(
      `[restartServers] Request to restart servers for extensions: ${extensions ? extensions.join(', ') : 'all'}\n`
    );

    // Collect servers to restart
    const serversToRestart: Array<{ key: string; state: ServerState }> = [];

    for (const [key, serverState] of this.serverManager.getRunningServers().entries()) {
      if (!extensions || extensions.some((ext) => serverState.config.extensions.includes(ext))) {
        serversToRestart.push({ key, state: serverState });
      }
    }

    if (serversToRestart.length === 0) {
      const message = extensions
        ? `No LSP servers found for extensions: ${extensions.join(', ')}`
        : 'No LSP servers are currently running';
      return { success: false, restarted: [], failed: [], message };
    }

    // Restart each server by disposing and re-getting via serverManager
    for (const { state } of serversToRestart) {
      const serverDesc = `${state.config.command.join(' ')} (${state.config.extensions.join(', ')})`;

      try {
        // Clear existing timer
        if (state.restartTimer) {
          clearTimeout(state.restartTimer);
          state.restartTimer = undefined;
        }

        // Terminate old server
        state.process.kill();

        // Remove from running servers and start new one
        this.serverManager.getRunningServers().delete(JSON.stringify(state.config));
        await this.serverManager.getServer(state.config);

        restarted.push(serverDesc);
        logger.debug(`[restartServers] Successfully restarted: ${serverDesc}\n`);
      } catch (error) {
        failed.push(`${serverDesc}: ${error}`);
        logger.error(`[restartServers] Failed to restart: ${serverDesc}: ${error}\n`);
      }
    }

    const success = failed.length === 0;
    let message: string;

    if (success) {
      message = `Successfully restarted ${restarted.length} LSP server(s)`;
    } else if (restarted.length > 0) {
      message = `Restarted ${restarted.length} server(s), but ${failed.length} failed`;
    } else {
      message = `Failed to restart all ${failed.length} server(s)`;
    }

    return { success, restarted, failed, message };
  }

  /**
   * Synchronize file content with LSP server after external modifications
   * This should be called after any disk writes to keep the LSP server in sync
   */
  async syncFileContent(filePath: string): Promise<void> {
    try {
      const serverState = await this.getServer(filePath);

      await serverState.documentManager.withWriter(async (scope) => {
        if (!serverState.documentManager.isOpen(filePath)) return;
        const fileContent = readFileSync(filePath, 'utf-8');
        serverState.documentManager.changeUnderScope(filePath, fileContent, scope);
      });
    } catch (error) {
      logger.error(`[syncFileContent] Failed to sync file ${filePath}: ${error}\n`);
      throw error;
    } finally {
      await this.astProvider.invalidate(filePath);
    }
  }

  private async getServer(filePath: string): Promise<ServerState> {
    logger.debug(`[getServer] Getting server for file: ${filePath}\n`);

    const serverConfig = this.getServerForFile(filePath);
    if (!serverConfig) {
      throw new NoConfiguredLanguageServerError(filePath);
    }

    logger.debug(`[getServer] Found server config: ${serverConfig.command.join(' ')}\n`);

    return this.serverManager.getServer(serverConfig);
  }

  async astSearch(input: AstSearchInput): Promise<AstSearchOutcome> {
    return this.astProvider.search(input);
  }

  async codeRewrite(input: AstRewriteInput): Promise<AstRewriteOutcome> {
    if (input.dryRun !== false) {
      const result = await this.astProvider.prepareRewrite(input);
      return result.outcome === 'prepared' ? result.prepared.publicPreview : result;
    }
    if (!input.candidateId) {
      return {
        outcome: 'rejected',
        provider: 'tree-sitter',
        isError: true,
        code: 'AST_REWRITE_PREVIEW_REQUIRED',
        reason: 'dry_run=false requires candidate_id from an inspected dry-run preview',
      };
    }
    return this.withRewriteApplyLock(async () => {
      const result = await this.astProvider.prepareRewrite(input);
      if (result.outcome !== 'prepared') return result;
      const actual = Buffer.from(result.prepared.candidateId);
      const supplied = Buffer.from(input.candidateId ?? '');
      if (actual.length !== supplied.length || !timingSafeEqual(actual, supplied)) {
        return {
          outcome: 'rejected',
          provider: 'tree-sitter',
          isError: true,
          code: 'AST_REWRITE_STALE',
          reason: 'Candidate identity no longer matches a fresh structural rewrite preview',
        };
      }
      const transaction = await this.withDocumentWriteScopes(
        result.prepared.files.map((file) => file.absolutePath),
        () =>
          applyAtomicRewrite(result.prepared, {
            synchronize: (files) => this.synchronizeRewriteFilesStrict(files),
            invalidate: async (paths) => {
              await Promise.all(paths.map((path) => this.astProvider.invalidate(path)));
            },
            inject: (stage, _file, index) => this.injectRewriteFailureForTest(stage, index),
          })
      );
      if (!transaction.success) {
        if (transaction.code === 'AST_REWRITE_STALE' && !transaction.rollback.attempted) {
          return {
            outcome: 'rejected',
            provider: 'tree-sitter',
            isError: true,
            code: 'AST_REWRITE_STALE',
            reason: transaction.error ?? 'Rewrite target changed before mutation',
            rollback: transaction.rollback,
          };
        }
        return {
          outcome: 'failed',
          provider: 'tree-sitter',
          isError: true,
          code: transaction.code ?? 'AST_REWRITE_TRANSACTION_FAILED',
          reason: transaction.error ?? 'Structural rewrite transaction failed',
          rollback: transaction.rollback,
        };
      }
      return {
        ...result.prepared.publicPreview,
        dryRun: false,
        filesModified: transaction.filesModified,
        changesApplied: result.prepared.publicPreview.changesPlanned,
        rollback: transaction.rollback,
      };
    });
  }

  async withDocumentWriteScopes<T>(paths: string[], action: () => Promise<T>): Promise<T> {
    const configurations = new Map<string, LSPServerConfig>();
    for (const path of paths) {
      const config = this.getServerForFile(path);
      if (config) configurations.set(JSON.stringify(config), config);
    }
    const states: ServerState[] = [];
    for (const [, config] of [...configurations].sort(([a], [b]) => a.localeCompare(b))) {
      states.push(await this.serverManager.getServer(config));
    }
    const run = (index: number): Promise<T> => {
      const state = states[index];
      return state ? state.documentManager.withWriter(() => run(index + 1)) : action();
    };
    return run(0);
  }

  async invalidateSourceFiles(paths: string[]): Promise<void> {
    await Promise.all(paths.map((path) => this.astProvider.invalidate(path)));
  }

  async synchronizeRewriteFilesStrict(
    files: Array<{ path: string; content: string }>
  ): Promise<void> {
    const groups = new Map<
      string,
      { config: LSPServerConfig; files: Array<{ path: string; content: string }> }
    >();
    for (const file of files) {
      const config = this.getServerForFile(file.path);
      if (!config) continue;
      const key = JSON.stringify(config);
      const group = groups.get(key);
      if (group) group.files.push(file);
      else groups.set(key, { config, files: [file] });
    }
    for (const group of groups.values()) {
      const serverState = await this.serverManager.getServer(group.config);
      await serverState.initializationPromise;
      await serverState.documentManager.withWriter(async (scope) => {
        for (const file of group.files) {
          if (!serverState.documentManager.isOpen(file.path)) continue;
          serverState.documentManager.changeUnderScope(file.path, file.content, scope);
          serverState.documentManager.setSyncSig(file.path, contentSignature(file.content));
          serverState.diagnosticsCache.delete(pathToUri(file.path));
        }
      });
    }
  }

  private injectRewriteFailureForTest(stage: AtomicRewriteStage, index?: number): void {
    if (process.env.CCLSP_REWRITE_TEST_MODE !== '1') return;
    const expected = process.env.CCLSP_REWRITE_TEST_FAILURE;
    if (!expected) return;
    const actual = `${stage}${index === undefined ? '' : `:${index}`}`;
    if (actual === expected) throw new Error(`injected structural rewrite failure at ${actual}`);
  }

  private async withRewriteApplyLock<T>(action: () => Promise<T>): Promise<T> {
    const previous = this.rewriteApplyTail;
    let release = (): void => undefined;
    this.rewriteApplyTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await action();
    } finally {
      release();
    }
  }

  async findDefinition(filePath: string, position: Position): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    return opsFindDefinition(serverState, filePath, position);
  }

  async findTypeDefinition(filePath: string, position: Position): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    if (!supportsMethod(serverState, 'textDocument/typeDefinition')) return [];
    return opsFindTypeDefinition(serverState, filePath, position);
  }

  async findDefinitionsWithProvider(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<ProviderDefinitions> {
    try {
      const { matches, warning, incomplete } = await this.findSymbolsByName(
        filePath,
        symbolName,
        symbolKind
      );
      if (matches.length === 0) {
        return {
          outcome: 'ok',
          provider: 'lsp',
          value: [],
          warning,
          matchedSymbols: 0,
          incomplete,
        };
      }
      const locations: Location[] = [];
      const seenLocations = new Set<string>();
      for (const match of matches) {
        const resolved =
          match.definitionLocations ?? (await this.findDefinition(filePath, match.position));
        for (const location of resolved) {
          const key = this.locationKey(location);
          if (seenLocations.has(key)) continue;
          seenLocations.add(key);
          locations.push(location);
        }
      }
      return {
        outcome: 'ok',
        provider: 'lsp',
        value: locations,
        warning,
        matchedSymbols: matches.length,
        incomplete,
        matchedDescriptions: matches.map((match) =>
          match.resolutionSource === 'query-occurrence'
            ? `${match.name} (query occurrence; semantic kind resolved by LSP)`
            : `${match.name} (${this.symbolKindToString(match.kind)})`
        ),
      };
    } catch (error) {
      if (!isAstFallbackEligible(error)) throw error;
      return preserveUnsupportedOrigin(
        error,
        await this.astProvider.findDeclarations(filePath, symbolName, symbolKind)
      );
    }
  }

  async findReferences(
    filePath: string,
    position: Position,
    includeDeclaration = true
  ): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    return opsFindReferences(serverState, filePath, position, includeDeclaration);
  }

  async renameSymbol(
    filePath: string,
    position: Position,
    newName: string,
    options: RenameOperationOptions = {}
  ): Promise<RenameOperationResult> {
    const serverState = await this.getServer(filePath);
    return opsRenameSymbol(serverState, filePath, position, newName, options);
  }

  private locationKey(location: Location): string {
    const { start, end } = location.range;
    return `${normalize(uriToPath(location.uri))}\u0000${start.line}\u0000${start.character}\u0000${end.line}\u0000${end.character}`;
  }

  private locationContainsPosition(
    location: Location,
    filePath: string,
    position: Position
  ): boolean {
    if (normalize(uriToPath(location.uri)) !== normalize(filePath)) return false;
    const { start, end } = location.range;
    const afterStart =
      position.line > start.line ||
      (position.line === start.line && position.character >= start.character);
    const beforeEnd =
      position.line < end.line ||
      (position.line === end.line && position.character <= end.character);
    return afterStart && beforeEnd;
  }

  symbolKindToString(kind: SymbolKind): string {
    return symbolKindToString(kind);
  }

  getValidSymbolKinds(): string[] {
    return getValidSymbolKinds();
  }

  async findSymbolsByName(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<SymbolQueryMatchResult> {
    // Resolve the file's symbols through the one owner of "an empty answer is not an answer",
    // then let the operation do only the matching. find_references, find_definition and
    // rename_symbol all arrive here by name, so placing the rule anywhere below this point
    // would fix one caller and leave its siblings reporting a named file's own declarations
    // absent. The operation keeps kind fallback and position resolution.
    const provided = await this.getDocumentSymbolsWithProvider(filePath);
    if (provided.outcome === 'ok') {
      const matched = await opsMatchSymbolsByName(filePath, provided.value, symbolName, symbolKind);

      // Imports and other use-only names are deliberately absent from documentSymbol. A local
      // declaration with the same text does not prove there is no import, so combine document
      // matches with import bindings. With no document match, use the bounded occurrence set.
      // Tree-sitter selects positions only; LSP definition targets own semantic identity.
      const syntax = await this.findQueryOccurrences(filePath, symbolName, symbolKind);
      const syntaxMatches =
        matched.matches.length > 0
          ? syntax.matches.filter((match) => match.importBinding)
          : syntax.matches;
      if (syntaxMatches.length === 0) return matched;
      const grouped = await this.groupQueryOccurrences(filePath, [
        ...matched.matches,
        ...syntaxMatches,
      ]);
      const ambiguityWarning =
        grouped.length > 1
          ? syntax.truncated
            ? `Found at least ${grouped.length} visible semantic symbols with the exact name "${symbolName}"; omitted occurrences may contain more.`
            : `Found ${grouped.length} semantic symbols with the exact name "${symbolName}"; results include every target.`
          : undefined;
      return {
        matches: grouped,
        incomplete: syntax.truncated,
        warning:
          [
            matched.warning,
            symbolKind
              ? 'Symbol kind could not be pre-filtered for use-only occurrences.'
              : undefined,
            syntax.truncated
              ? `Syntax occurrences exceeded the ${MAX_QUERY_OCCURRENCES} result bound; use an exact position to inspect omitted targets.`
              : undefined,
            ambiguityWarning,
          ]
            .filter(Boolean)
            .join(' ') || undefined,
      };
    }
    const serverState = await this.getServer(filePath);
    return opsFindSymbolsByName(serverState, filePath, symbolName, symbolKind);
  }

  private async findQueryOccurrences(
    filePath: string,
    symbolName: string,
    symbolKind?: string
  ): Promise<{ matches: SymbolMatch[]; truncated: boolean }> {
    // A by-name fallback selects identifier occurrences, never an arbitrary expression that
    // merely parses (for example `a|b`). Qualified/fuzzy names remain document-symbol queries.
    if (!/^[\p{ID_Start}_$][\p{ID_Continue}$]*$/u.test(symbolName)) {
      return { matches: [], truncated: false };
    }
    const found = await this.astProvider.queryOccurrences(
      filePath,
      symbolName,
      MAX_QUERY_OCCURRENCES
    );
    return {
      matches: found.occurrences.map((occurrence) => ({
        name: symbolName,
        kind: (symbolKind ? stringToSymbolKind(symbolKind) : null) ?? SymbolKind.Variable,
        resolutionSource: 'query-occurrence' as const,
        importBinding: occurrence.importBinding,
        position: occurrence.range.start,
        range: occurrence.range,
        detail: 'syntax-located query occurrence; semantic identity is resolved by LSP',
      })),
      truncated: found.truncated || found.recovered === true,
    };
  }

  private async groupQueryOccurrences(
    filePath: string,
    occurrences: SymbolMatch[]
  ): Promise<SymbolMatch[]> {
    const grouped = new Map<string, SymbolMatch>();
    for (const occurrence of occurrences) {
      let definitions = await this.findDefinition(filePath, occurrence.position);
      if (
        occurrence.importBinding &&
        definitions.length > 0 &&
        definitions.every((location) =>
          occurrences.some((candidate) =>
            this.locationContainsPosition(location, filePath, candidate.position)
          )
        )
      ) {
        const typeDefinitions = await this.findTypeDefinition(filePath, occurrence.position);
        if (typeDefinitions.length > 0) definitions = typeDefinitions;
      }
      const definitionKey =
        definitions.length > 0
          ? definitions
              .map((location) => this.locationKey(location))
              .sort()
              .join('\u0001')
          : `unresolved\u0000${occurrence.position.line}\u0000${occurrence.position.character}`;
      if (!grouped.has(definitionKey)) {
        grouped.set(definitionKey, { ...occurrence, definitionLocations: definitions });
      }
    }
    return [...grouped.values()];
  }

  async getDocumentSymbols(filePath: string): Promise<DocumentSymbol[] | SymbolInformation[]> {
    const serverState = await this.getServer(filePath);
    return opsGetDocumentSymbols(serverState, filePath);
  }

  async getDocumentSymbolsWithProvider(filePath: string): Promise<ProviderDocumentSymbols> {
    try {
      const symbols = await this.getDocumentSymbols(filePath);
      // A server that is still indexing answers this successfully with zero symbols, so
      // "did not throw" is not the same as "answered". Treating it as an answer is what let a
      // caller-named file report its own declarations as absent: every consumer of this result
      // reads empty as a fact about the file. Tree-sitter parses the one file directly and needs
      // no server, so it can settle that question now; it only ever replaces an empty list, and
      // when it is also empty the file genuinely declares nothing and the LSP answer stands.
      if (symbols.length === 0) {
        const parsed = await this.astProvider.documentSymbols(filePath);
        if (parsed.outcome === 'ok' && parsed.value.length > 0) return parsed;
      }
      return { outcome: 'ok', provider: 'lsp', value: symbols };
    } catch (error) {
      if (!isAstFallbackEligible(error)) throw error;
      return preserveUnsupportedOrigin(error, await this.astProvider.documentSymbols(filePath));
    }
  }

  async getCompletions(
    filePath: string,
    position: Position,
    triggerCharacter?: string,
    syntheticTrigger = false
  ): Promise<CompletionResult & { syntheticTrigger: boolean }> {
    const serverState = await this.getServer(filePath);
    return opsGetCompletions(serverState, filePath, position, triggerCharacter, syntheticTrigger);
  }

  async supportsCompletionResolve(filePath: string): Promise<boolean> {
    const serverState = await this.getServer(filePath);
    await serverState.initializationPromise;
    return supportsMethod(serverState, 'completionItem/resolve');
  }

  async resolveCompletionItem(
    filePath: string,
    item: CompletionItemResult,
    timeout = 2000
  ): Promise<CompletionItemResult> {
    const serverState = await this.getServer(filePath);
    return opsResolveCompletionItem(serverState, item, timeout);
  }

  async getSignatureHelp(
    filePath: string,
    position: Position,
    triggerCharacter?: string
  ): Promise<SignatureHelpResult | null> {
    const serverState = await this.getServer(filePath);
    return opsGetSignatureHelp(serverState, filePath, position, triggerCharacter);
  }

  async getCodeActions(
    filePath: string,
    range: { start: Position; end: Position }
  ): Promise<CodeActionResult[]> {
    const serverState = await this.getServer(filePath);
    return opsGetCodeActions(serverState, filePath, range);
  }

  async resolveCodeAction(filePath: string, action: CodeActionResult): Promise<CodeActionResult> {
    const serverState = await this.getServer(filePath);
    return opsResolveCodeAction(serverState, action);
  }

  async willRenameFiles(oldPath: string, newPath: string): Promise<WorkspaceEditResult> {
    const serverState = await this.getServer(oldPath);
    return opsWillRenameFiles(serverState, oldPath, newPath);
  }

  private async fileRenameGroups(
    moves: FileRenamePair[]
  ): Promise<Map<string, { state: ServerState; moves: FileRenamePair[] }>> {
    const groups = new Map<string, { state: ServerState; moves: FileRenamePair[] }>();
    for (const move of moves) {
      const state = await this.getServer(move.oldPath);
      const key = JSON.stringify(state.config);
      const group = groups.get(key);
      if (group) group.moves.push(move);
      else groups.set(key, { state, moves: [move] });
    }
    return groups;
  }

  async willRenameFilesBatch(moves: FileRenamePair[]): Promise<WorkspaceEditResult> {
    const groups = await this.fileRenameGroups(moves);
    const answers = await Promise.all(
      [...groups.values()].map(({ state, moves: groupedMoves }) =>
        opsWillRenameFilesBatch(state, groupedMoves)
      )
    );
    const changes: NonNullable<WorkspaceEditResult['changes']> = {};
    for (const answer of answers) {
      for (const [uri, edits] of Object.entries(answer.changes ?? {})) {
        changes[uri] = [...(changes[uri] ?? []), ...edits];
      }
    }
    return { changes };
  }

  async didRenameFiles(oldPath: string, newPath: string): Promise<void> {
    try {
      const serverState = await this.getServer(oldPath);
      await serverState.documentManager.withWriter(async (scope) => {
        serverState.documentManager.renameOpenDocument(oldPath, newPath, scope);
        await opsDidRenameFiles(serverState, oldPath, newPath);
      });
    } finally {
      await this.astProvider.invalidate(oldPath);
      await this.astProvider.invalidate(newPath);
    }
  }

  async didRenameFilesBatch(moves: FileRenamePair[]): Promise<void> {
    const groups = await this.fileRenameGroups(moves);
    try {
      for (const { state, moves: groupedMoves } of groups.values()) {
        await state.documentManager.withWriter(async (scope) => {
          for (const move of groupedMoves) {
            state.documentManager.renameOpenDocument(move.oldPath, move.newPath, scope);
          }
          await opsDidRenameFilesBatch(state, groupedMoves);
        });
      }
    } finally {
      await Promise.all(
        moves
          .flatMap((move) => [move.oldPath, move.newPath])
          .map((path) => this.astProvider.invalidate(path))
      );
    }
  }

  async getDiagnostics(filePath: string): Promise<Diagnostic[]> {
    const serverState = await this.getServer(filePath);
    return opsGetDiagnostics(serverState, filePath);
  }

  async getDiagnosticsReport(filePath: string) {
    return opsGetDiagnosticsReport(await this.getServer(filePath), filePath);
  }

  async getDiagnosticsBatch(filePaths: string[]): Promise<BatchDiagnosticResult[]> {
    // Group files by their LSP server
    const serverGroups = new Map<string, { serverConfig: LSPServerConfig; paths: string[] }>();

    for (const filePath of filePaths) {
      const serverConfig = this.getServerForFile(filePath);
      if (!serverConfig) {
        throw new Error(`LSP_DIAGNOSTICS_UNKNOWN: no configured server for ${filePath}`);
      }
      const key = JSON.stringify(serverConfig);
      const group = serverGroups.get(key);
      if (group) {
        group.paths.push(filePath);
      } else {
        serverGroups.set(key, { serverConfig, paths: [filePath] });
      }
    }

    // Process each server group in parallel
    const groupPromises = Array.from(serverGroups.values()).map(async ({ serverConfig, paths }) => {
      const serverState = await this.serverManager.getServer(serverConfig);
      return opsGetDiagnosticsBatch(serverState, paths);
    });

    const groupResults = await Promise.all(groupPromises);
    return groupResults.flat();
  }

  async hoverBatch(filePath: string, positions: Position[]) {
    const serverState = await this.getServer(filePath);
    return opsHoverBatch(serverState, filePath, positions);
  }

  async hover(
    filePath: string,
    position: Position
  ): Promise<{
    contents: string | { kind: string; value: string };
    range?: { start: Position; end: Position };
  } | null> {
    const serverState = await this.getServer(filePath);
    return opsHover(serverState, filePath, position);
  }

  /**
   * Search the workspace, and report whether the answer may be trusted as
   * COMPLETE. `readinessConfirmed: false` means a server could not be shown to
   * be answering from a loaded project within the budget, so zero rows is "not
   * answering yet" rather than "no such symbol" — a distinction only this layer
   * can still make.
   */
  async workspaceSymbol(
    query: string
  ): Promise<{ symbols: SymbolInformation[]; readinessConfirmed: boolean }> {
    let servers = Array.from(this.serverManager.getRunningServers().values());
    if (servers.length === 0) {
      logger.debug('[workspaceSymbol] No LSP servers running; preloading now\n');
      await this.preloadServers(false);
      servers = Array.from(this.serverManager.getRunningServers().values());
      if (servers.length === 0) {
        logger.debug('[workspaceSymbol] No LSP servers available after preload\n');
        return { symbols: [], readinessConfirmed: false };
      }
    } else if (this.workspaceSymbolUnavailableServers.size > 0) {
      logger.debug('[workspaceSymbol] Retrying only failed workspace providers\n');
      this.workspaceSymbolRecovery ??= this.retryUnavailableWorkspaceProviders().finally(() => {
        this.workspaceSymbolRecovery = null;
      });
      await this.workspaceSymbolRecovery;
      servers = Array.from(this.serverManager.getRunningServers().values());
      if (servers.length === 0) {
        logger.debug('[workspaceSymbol] No LSP servers available after preload\n');
        return { symbols: [], readinessConfirmed: false };
      }
    }

    // Every language server concurrently, so a multi-language workspace (TS + PHP)
    // isn't gated by the slowest server one-at-a-time.
    const errors: unknown[] = [];
    const perServer = await Promise.all(
      servers.map(async (serverState) => {
        if (!serverState) return { symbols: [] as SymbolInformation[], confirmed: true };
        // Skipped before any seed is opened: a YAML or JSON server sharing the root
        // would otherwise make every name search fail with ITS refusal.
        if (!supportsMethod(serverState, 'workspace/symbol')) {
          return { symbols: [] as SymbolInformation[], confirmed: true };
        }
        try {
          return await this.queryWorkspaceSymbol(serverState, query);
        } catch (error) {
          // Same rule for a server that advertises the capability and refuses only
          // when asked: unsupported is a fact about that server, never about the symbol.
          if (error instanceof LspToolOutcomeError && error.outcome.outcome === 'unsupported') {
            return { symbols: [] as SymbolInformation[], confirmed: true };
          }
          errors.push(error);
          logger.debug(`[workspaceSymbol] Server failed for query "${query}": ${error}\n`);
          return { symbols: [] as SymbolInformation[], confirmed: false };
        }
      })
    );

    const results = perServer.flatMap((entry) => entry.symbols);
    if (results.length === 0 && errors.length > 0) {
      throw errors[0];
    }
    // A surviving unrelated provider cannot certify absence for one that failed.
    return {
      symbols: results,
      readinessConfirmed:
        this.workspaceSymbolUnavailableServers.size === 0 &&
        perServer.every((entry) => entry.confirmed),
    };
  }

  /**
   * One `workspace/symbol` per scope the server actually searches.
   *
   * A workspace-wide provider (intelephense, gopls) is asked once, after its
   * index/package load is confirmed. A provider that scopes the request to its
   * most recently touched document (tsserver: navto searches only that file's
   * project) is steered through every seeded project: touch one seed per scope,
   * confirm that project is loaded, ask, merge. Without that, one query answers
   * for ONE project and reads as absence for every other — the measured false
   * zero. The seeds are discovered once per server; the program loads they
   * trigger are paid once per process, and every later call costs one cheap
   * request per scope.
   */
  private async queryWorkspaceSymbol(
    serverState: ServerState,
    query: string
  ): Promise<{ symbols: SymbolInformation[]; confirmed: boolean }> {
    const seeds = await this.workspaceSymbolSeedsFor(serverState);
    const scopeOf = serverState.adapter?.workspaceSymbolScope?.bind(serverState.adapter);
    if (!scopeOf) {
      const confirmed = await this.confirmWorkspaceWideReady(serverState, seeds);
      return { symbols: await opsWorkspaceSymbol(serverState, query), confirmed };
    }

    // One seed per distinct scope: eleven source directories under one tsconfig
    // are one project and one request, not eleven.
    const seedByScope = new Map<string, string>();
    for (const seed of seeds) {
      const key = scopeOf(serverState, seed);
      if (!seedByScope.has(key)) seedByScope.set(key, seed);
    }
    if (seedByScope.size === 0) {
      return { symbols: await opsWorkspaceSymbol(serverState, query), confirmed: false };
    }

    const merged: SymbolInformation[] = [];
    const seen = new Set<string>();
    let confirmed = true;
    for (const seed of seedByScope.values()) {
      const answer = await this.askInScope(serverState, seed, query);
      confirmed &&= answer.ready;
      for (const symbol of answer.symbols) {
        const start = symbol.location.range.start;
        const key = `${symbol.location.uri}\u0000${start.line}\u0000${start.character}\u0000${symbol.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        merged.push(symbol);
      }
    }
    return { symbols: merged, confirmed };
  }

  /**
   * Touch one seed, confirm its project, then ask. Serialized per server: the
   * scope is "the last touched document", so two names asked concurrently would
   * race each other's touch and answer from the wrong project.
   */
  private askInScope(
    serverState: ServerState,
    seed: string,
    query: string
  ): Promise<{ symbols: SymbolInformation[]; ready: boolean }> {
    const previous = this.workspaceSymbolScopeTail.get(serverState) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(async () => {
        // documentSymbol both selects the scope and makes a lazy server load the
        // project that contains the seed; readiness is then asked, never assumed.
        let ready = true;
        try {
          await opsGetDocumentSymbols(serverState, seed);
        } catch (error) {
          logger.debug(`[workspaceSymbol] Could not touch scope seed ${seed}: ${error}\n`);
          ready = false;
        }
        if (ready && serverState.adapter?.waitForProjectReady) {
          ready = await serverState.adapter.waitForProjectReady(
            serverState,
            seed,
            WORKSPACE_SYMBOL_READY_BUDGET_MS
          );
        }
        return { symbols: await opsWorkspaceSymbol(serverState, query), ready };
      });
    this.workspaceSymbolScopeTail.set(
      serverState,
      run.then(
        () => undefined,
        () => undefined
      )
    );
    return run;
  }

  /**
   * A workspace-wide provider is ready once its adapter says so (intelephense
   * announces the end of its index). Without an adapter, opening the seeds and
   * letting their diagnostics settle is the only available evidence of a package
   * load (gopls); it witnesses the seeds' own packages, and is accepted as it
   * always was. Paid once per server.
   */
  private async confirmWorkspaceWideReady(
    serverState: ServerState,
    seeds: string[]
  ): Promise<boolean> {
    if (this.workspaceSymbolConfirmedServers.has(serverState)) return true;
    const inFlight = this.workspaceSymbolConfirmInFlight.get(serverState);
    if (inFlight) return await inFlight;

    const run = (async () => {
      const seedLeases = (
        await Promise.all(
          seeds.map((seed) =>
            serverState.documentManager.acquire(seed).catch((error) => {
              logger.debug(`[workspaceSymbol] Failed to open seed ${seed}: ${error}\n`);
              return undefined;
            })
          )
        )
      ).filter((lease) => lease !== undefined);
      try {
        const [firstSeed] = seeds;
        if (serverState.adapter?.waitForProjectReady && firstSeed) {
          return await serverState.adapter.waitForProjectReady(
            serverState,
            firstSeed,
            WORKSPACE_SYMBOL_READY_BUDGET_MS
          );
        }
        const deadline = Date.now() + WORKSPACE_SYMBOL_READY_BUDGET_MS;
        await Promise.all(
          seeds.map((seed) =>
            opsGetDocumentSymbols(serverState, seed).catch((error) => {
              logger.debug(`[workspaceSymbol] Seed documentSymbol failed for ${seed}: ${error}\n`);
              return [];
            })
          )
        );
        await Promise.all(
          seeds.map((seed) =>
            serverState.diagnosticsCache
              .waitForIdle(pathToUri(seed), {
                maxWaitTime: Math.min(15000, Math.max(0, deadline - Date.now())),
                idleTime: 300,
                checkInterval: 50,
              })
              .catch(() => undefined)
          )
        );
        return true;
      } finally {
        for (const lease of seedLeases) lease.release();
      }
    })();

    this.workspaceSymbolConfirmInFlight.set(serverState, run);
    try {
      const confirmed = await run;
      // Only a confirmed server stays confirmed; an index that did not finish in
      // the budget is re-checked next call instead of sticking as "ready".
      if (confirmed) this.workspaceSymbolConfirmedServers.add(serverState);
      logger.debug(`[workspaceSymbol] Workspace-wide readiness confirmed=${confirmed}\n`);
      return confirmed;
    } finally {
      this.workspaceSymbolConfirmInFlight.delete(serverState);
    }
  }

  /** Seeds are discovered once per server; a repository scan per query would dwarf the query. */
  private async workspaceSymbolSeedsFor(serverState: ServerState): Promise<string[]> {
    const known = this.workspaceSymbolSeeds.get(serverState);
    if (known) return known;
    const seeds = await this.findWorkspaceSymbolSeedFiles(serverState.config);
    this.workspaceSymbolSeeds.set(serverState, seeds);
    logger.debug(`[workspaceSymbol] ${seeds.length} seed file(s) select the query scopes\n`);
    return seeds;
  }

  private async findWorkspaceSymbolSeedFiles(serverConfig: LSPServerConfig): Promise<string[]> {
    const rootDir = this.resolveRootDir(serverConfig.rootDir);
    const extensions = new Set(serverConfig.extensions.map((ext) => ext.toLowerCase()));
    const ignoreFilter = await loadGitignore(rootDir);
    const projectRoots = await this.findWorkspaceSymbolProjectRoots(rootDir, ignoreFilter);
    // Cap the opens so a huge monorepo can't blow up priming.
    const MAX_SEED_FILES = 25;
    const roots = projectRoots.length > 0 ? projectRoots : [rootDir];
    const seedsByRoot = new Map<string, string[]>();
    for (const projectRoot of roots) {
      const projectFiles = await this.findWorkspaceSymbolProjectFiles(
        rootDir,
        projectRoot,
        extensions,
        ignoreFilter
      );
      const perDirectory = new Map<string, string>();
      for (const file of projectFiles) {
        const directory = dirname(relative(projectRoot, file)).split(sep)[0] ?? '.';
        if (!perDirectory.has(directory)) perDirectory.set(directory, file);
      }
      seedsByRoot.set(projectRoot, [...perDirectory.values()]);
    }

    // Reserve one slot for every configured project before spending remaining
    // capacity on extra source directories. Otherwise one large first project
    // can consume all 25 slots and make every later project look empty.
    const seedFiles = [...seedsByRoot.values()].flatMap((seeds) => seeds.slice(0, 1));
    if (seedFiles.length > MAX_SEED_FILES) return seedFiles.slice(0, MAX_SEED_FILES);
    for (const seeds of seedsByRoot.values()) {
      for (const seed of seeds.slice(1)) {
        if (seedFiles.length >= MAX_SEED_FILES) return seedFiles;
        seedFiles.push(seed);
      }
    }
    return seedFiles;
  }

  private async findWorkspaceSymbolProjectRoots(
    rootDir: string,
    ignoreFilter: Awaited<ReturnType<typeof loadGitignore>>
  ): Promise<string[]> {
    const roots = new Set<string>();
    const maxDepth = 5;
    // Markers that identify a language-project root. Generalized beyond TS so
    // PHP (composer.json), Go (go.mod), and Python (pyproject.toml) monorepos
    // each get a seed per sub-project.
    const PROJECT_MARKERS = [
      'tsconfig.json',
      'jsconfig.json',
      'composer.json',
      'go.mod',
      'pyproject.toml',
    ];

    const scan = async (
      currentPath: string,
      currentDepth: number,
      relativePath = ''
    ): Promise<void> => {
      if (currentDepth > maxDepth) return;

      let entries: string[];
      try {
        entries = (await readdir(currentPath)).sort();
      } catch (error) {
        logger.debug(`[workspaceSymbol] Failed to read ${currentPath}: ${error}\n`);
        return;
      }

      if (PROJECT_MARKERS.some((marker) => entries.includes(marker))) {
        roots.add(currentPath);
      }

      for (const entry of entries) {
        const fullPath = join(currentPath, entry);
        const entryRelativePath = relativePath ? join(relativePath, entry) : entry;
        const normalizedRelativePath = entryRelativePath.replace(/\\/g, '/');

        if (ignoreFilter.ignores(normalizedRelativePath)) {
          continue;
        }

        let fileStat: Stats;
        try {
          fileStat = await stat(fullPath);
        } catch (error) {
          logger.debug(`[workspaceSymbol] Failed to stat ${fullPath}: ${error}\n`);
          continue;
        }

        if (fileStat.isDirectory()) {
          await scan(fullPath, currentDepth + 1, entryRelativePath);
        }
      }
    };

    await scan(rootDir, 0);
    return Array.from(roots).sort();
  }

  private async findWorkspaceSymbolProjectFiles(
    rootDir: string,
    projectRoot: string,
    extensions: Set<string>,
    ignoreFilter: Awaited<ReturnType<typeof loadGitignore>>
  ): Promise<string[]> {
    const maxDepth = 10;
    const extensionPriority = ['ts', 'tsx', 'js', 'jsx'];
    const priority = (filePath: string): number => {
      const ext = extname(filePath).toLowerCase().slice(1);
      const index = extensionPriority.indexOf(ext);
      return index === -1 ? extensionPriority.length : index;
    };

    const scan = async (
      currentPath: string,
      currentDepth: number,
      relativePath = ''
    ): Promise<string[]> => {
      if (currentDepth > maxDepth) return [];

      let entries: string[];
      try {
        entries = (await readdir(currentPath)).sort();
      } catch (error) {
        logger.debug(`[workspaceSymbol] Failed to read ${currentPath}: ${error}\n`);
        return [];
      }

      const matches: string[] = [];

      for (const entry of entries) {
        const fullPath = join(currentPath, entry);
        const projectRelativePath = relativePath ? join(relativePath, entry) : entry;
        const rootRelativePath = relative(rootDir, fullPath);
        const normalizedRelativePath = rootRelativePath.replace(/\\/g, '/');

        if (ignoreFilter.ignores(normalizedRelativePath)) {
          continue;
        }

        let fileStat: Stats;
        try {
          fileStat = await stat(fullPath);
        } catch (error) {
          logger.debug(`[workspaceSymbol] Failed to stat ${fullPath}: ${error}\n`);
          continue;
        }

        if (fileStat.isFile()) {
          const ext = extname(entry).toLowerCase().slice(1);
          if (extensions.has(ext)) {
            matches.push(fullPath);
          }
          continue;
        }

        if (fileStat.isDirectory()) {
          matches.push(...(await scan(fullPath, currentDepth + 1, projectRelativePath)));
        }
      }

      return matches.sort(
        (left, right) => priority(left) - priority(right) || left.localeCompare(right)
      );
    };

    return scan(projectRoot, 0);
  }

  private resolveRootDir(rootDir?: string): string {
    if (!rootDir) {
      return process.cwd();
    }

    return normalize(isAbsolute(rootDir) ? rootDir : join(process.cwd(), rootDir));
  }

  async findImplementation(filePath: string, position: Position): Promise<Location[]> {
    const serverState = await this.getServer(filePath);
    return opsFindImplementation(serverState, filePath, position);
  }

  async prepareCallHierarchy(filePath: string, position: Position): Promise<CallHierarchyItem[]> {
    const serverState = await this.getServer(filePath);
    return opsPrepareCallHierarchy(serverState, filePath, position);
  }

  async incomingCalls(item: CallHierarchyItem): Promise<CallHierarchyIncomingCall[]> {
    const filePath = uriToPath(item.uri);
    const serverState = await this.getServer(filePath);
    return opsIncomingCalls(serverState, item);
  }

  async outgoingCalls(item: CallHierarchyItem): Promise<CallHierarchyOutgoingCall[]> {
    const filePath = uriToPath(item.uri);
    const serverState = await this.getServer(filePath);
    return opsOutgoingCalls(serverState, item);
  }

  private async retryUnavailableWorkspaceProviders(): Promise<void> {
    const failedKeys = [...this.workspaceSymbolUnavailableServers];
    await Promise.all(
      failedKeys.map(async (key) => {
        const config = this.config.servers.find((server) => JSON.stringify(server) === key);
        if (!config) {
          this.workspaceSymbolUnavailableServers.delete(key);
          return;
        }
        try {
          await this.serverManager.getServer(config);
          this.workspaceSymbolUnavailableServers.delete(key);
        } catch (error) {
          logger.debug(
            `[workspaceSymbol] Failed provider remains unavailable (${config.extensions.join(', ')}): ${error}\n`
          );
        }
      })
    );
  }

  async preloadServers(debug = true): Promise<void> {
    if (debug) {
      logger.info('Scanning configured server directories for supported file types\n');
    }

    const serversToStart = new Set<LSPServerConfig>();

    // Scan each server's rootDir for its configured extensions
    for (const serverConfig of this.config.servers) {
      const serverDir = serverConfig.rootDir || process.cwd();

      if (debug) {
        logger.info(
          `Scanning ${serverDir} for extensions: ${serverConfig.extensions.join(', ')}\n`
        );
      }

      try {
        const ig = await loadGitignore(serverDir);
        const foundExtensions = await scanDirectoryForExtensions(serverDir, 3, ig, false);

        // Check if any of this server's extensions are found in its rootDir
        const hasMatchingExtensions = serverConfig.extensions.some((ext) =>
          foundExtensions.has(ext)
        );

        if (hasMatchingExtensions) {
          serversToStart.add(serverConfig);
          if (debug) {
            const matchingExts = serverConfig.extensions.filter((ext) => foundExtensions.has(ext));
            logger.info(`Found matching extensions in ${serverDir}: ${matchingExts.join(', ')}\n`);
          }
        }
      } catch (error) {
        if (debug) {
          logger.error(`Failed to scan ${serverDir}: ${error}\n`);
        }
      }
    }

    if (debug) {
      logger.info(`Starting ${serversToStart.size} LSP servers...\n`);
    }

    const startPromises = Array.from(serversToStart).map(async (serverConfig) => {
      try {
        if (debug) {
          logger.info(`Preloading LSP server: ${serverConfig.command.join(' ')}\n`);
        }
        await this.serverManager.getServer(serverConfig);
        this.workspaceSymbolUnavailableServers.delete(JSON.stringify(serverConfig));
        if (debug) {
          logger.info(
            `Successfully preloaded LSP server for extensions: ${serverConfig.extensions.join(', ')}\n`
          );
        }
      } catch (error) {
        this.workspaceSymbolUnavailableServers.add(JSON.stringify(serverConfig));
        logger.error(
          `Failed to preload LSP server for ${serverConfig.extensions.join(', ')}: ${error}\n`
        );
      }
    });

    await Promise.all(startPromises);
    if (debug) {
      logger.info('LSP server preloading completed\n');
    }
  }

  async dispose(): Promise<void> {
    await this.astProvider.dispose();
    await this.serverManager.dispose();
  }
}
