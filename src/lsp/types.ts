// Re-export all shared types from the main types module
export type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  CodeDescription,
  Config,
  DefinitionResult,
  Diagnostic,
  DiagnosticRelatedInformation,
  DocumentDiagnosticReport,
  DocumentSymbol,
  LSPError,
  LSPLocation,
  LSPServerConfig,
  Location,
  Position,
  ReferenceResult,
  SymbolInformation,
  SymbolMatch,
  SymbolSearchParams,
} from '../types.js';
export {
  DiagnosticSeverity,
  DiagnosticTag,
  SymbolKind,
  SymbolTag,
} from '../types.js';

// --- LSP-internal types (single source of truth) ---

import type { ChildProcess } from 'node:child_process';
import type { Diagnostic, LSPError, LSPServerConfig } from '../types.js';

/**
 * JSON-RPC message format used for LSP communication.
 */
export interface LSPMessage {
  jsonrpc: string;
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: LSPError;
}

/**
 * State of a running LSP server process.
 * Single source of truth -- do NOT duplicate this interface elsewhere.
 *
 * transport, documentManager, and diagnosticsCache use structural types
 * rather than concrete class imports to keep types.ts as a dependency leaf
 * (no imports from sibling lsp/ modules that import back from here).
 */
export interface ServerState {
  process: ChildProcess;
  transport: {
    sendRequest(method: string, params: unknown, timeout?: number): Promise<unknown>;
    sendMessage(message: LSPMessage): void;
    sendNotification(method: string, params: unknown): void;
    rejectAllPending(reason: string): void;
  };
  documentManager: {
    readonly capacity: number;
    withWriter<T>(action: (scope: { readonly epoch: number }) => Promise<T>): Promise<T>;
    changeUnderScope(path: string, text: string, scope: { readonly epoch: number }): void;
    renameOpenDocument(oldPath: string, newPath: string, scope: { readonly epoch: number }): void;
    acquireChunk(paths: string[]): Promise<Array<{ justOpened: boolean; release(): void }>>;
    reconcile(): Promise<{
      epoch: number;
      contents: Map<string, string>;
      bytesCompared: number;
      resynced: string[];
      waitedFor?: string[];
    }>;
    changedSince(snapshot: { epoch: number; contents: Map<string, string> }): Promise<string[]>;
    acquire(
      filePath: string,
      exclusive?: boolean
    ): Promise<{ justOpened: boolean; release(): void }>;
    sendChange(filePath: string, text: string): void;
    withTemporaryContent<T>(
      filePath: string,
      temporaryText: string,
      action: () => Promise<T>
    ): Promise<T>;
    isOpen(filePath: string): boolean;
    getText(filePath: string): string | undefined;
    getVersion(filePath: string): number;
    getSyncSig(filePath: string): string | undefined;
    setSyncSig(filePath: string, signature: string): void;
  };
  initialized: boolean;
  serverCapabilities: Record<string, unknown>;
  initializationPromise: Promise<void>;
  startTime: number;
  config: LSPServerConfig;
  restartTimer?: NodeJS.Timeout;
  initializationResolve?: () => void;
  // Workspace-indexing servers (e.g. intelephense) report progress via custom
  // notifications. Adapters flip these flags so workspace/symbol can wait for a
  // complete index instead of racing an in-progress one. Undefined for servers
  // that load lazily per file (tsserver, gopls).
  indexingStarted?: boolean;
  indexingComplete?: boolean;
  diagnosticsCache: {
    update(uri: string, items: Diagnostic[], version?: number): void;
    get(uri: string): Diagnostic[] | undefined;
    delete(uri: string): void;
    waitForIdle(
      uri: string,
      options?: {
        maxWaitTime?: number;
        idleTime?: number;
        checkInterval?: number;
      }
    ): Promise<void>;
    waitForAllIdle(
      uris: string[],
      options?: {
        maxWaitTime?: number;
        idleTime?: number;
        checkInterval?: number;
      }
    ): Promise<void>;
  };
  adapter?: ServerAdapter;
}

/**
 * LSP server adapter for handling server-specific behavior.
 * This is an internal interface - no user extensions supported.
 *
 * Adapters allow cclsp to handle LSP servers that deviate from the standard
 * protocol or have special requirements.
 */
export interface ServerAdapter {
  /** Optional request-based diagnostics for providers without standard pull. */
  pullDiagnostics?(
    state: ServerState,
    filePath: string,
    timeout: number
  ): Promise<Diagnostic[] | null>;
  /** Adapter name for logging */
  readonly name: string;

  /**
   * Check if this adapter should be used for the given config.
   * Called during server initialization to auto-detect the appropriate adapter.
   */
  matches(config: LSPServerConfig): boolean;

  /**
   * Customize initialization parameters before sending to server.
   * Use this to add server-specific initialization options.
   */
  customizeInitializeParams?(params: InitializeParams): InitializeParams;

  /**
   * Handle custom notifications from server.
   * Return true if handled, false to fall through to standard handling.
   */
  handleNotification?(method: string, params: unknown, state: ServerState): boolean;

  /**
   * Handle custom requests from server.
   * Should return a promise that resolves to the response.
   * Throw an error to indicate the request was not handled.
   */
  handleRequest?(method: string, params: unknown, state: ServerState): Promise<unknown>;

  /**
   * Get custom timeout for specific LSP methods.
   * Return undefined to use the default timeout (30000ms).
   */
  getTimeout?(method: string): number | undefined;

  /**
   * True for servers that build a workspace-wide index asynchronously after
   * initialization (e.g. intelephense) and signal completion via custom
   * notifications. workspace/symbol priming waits for `state.indexingComplete`
   * on these instead of opening seed files to force lazy project loading.
   */
  isWorkspaceIndexingServer?(): boolean;
}

/**
 * LSP InitializeParams type
 * Subset of the full LSP specification
 */
export interface InitializeResult {
  capabilities: Record<string, unknown>;
  serverInfo?: { name: string; version?: string };
}

export interface InitializeParams {
  processId: number | null;
  clientInfo: { name: string; version: string };
  capabilities: unknown;
  rootUri: string;
  workspaceFolders: Array<{ uri: string; name: string }>;
  initializationOptions?: unknown;
}
