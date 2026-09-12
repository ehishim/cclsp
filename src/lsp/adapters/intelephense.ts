import { homedir } from 'node:os';
import { join } from 'node:path';
import { logger } from '../../logger.js';
import type { LSPServerConfig } from '../../types.js';
import { pathToUri } from '../../utils.js';
import type { Diagnostic, InitializeParams, ServerAdapter, ServerState } from '../types.js';

/**
 * Adapter for Intelephense (PHP language server).
 *
 * Intelephense builds a workspace-wide symbol index asynchronously right after
 * initialization and reports progress through the custom `indexingStarted` /
 * `indexingEnded` notifications. Until indexing finishes, workspace/symbol
 * returns partial results.
 *
 * This adapter:
 * - Tracks indexing state on the ServerState so `waitForProjectReady` can
 *   confirm a complete index before workspace/symbol is trusted.
 * - Extends timeouts for operations that may run while the index is still warm.
 */
export class IntelephenseAdapter implements ServerAdapter {
  readonly name = 'intelephense';
  private readonly readinessWaiters = new WeakMap<ServerState, Set<() => void>>();

  matches(config: LSPServerConfig): boolean {
    return config.command.some((c: string) => c.includes('intelephense'));
  }

  customizeInitializeParams(params: InitializeParams): InitializeParams {
    const options =
      params.initializationOptions && typeof params.initializationOptions === 'object'
        ? (params.initializationOptions as Record<string, unknown>)
        : {};
    return {
      ...params,
      // Intelephense's official client supplies these locations so the CLI uses the
      // same activated premium engine and persistent index as its VS Code client.
      initializationOptions: {
        storagePath:
          process.env.INTELEPHENSE_STORAGE_PATH ??
          join(homedir(), '.config', 'intelephense', 'workspace'),
        globalStoragePath:
          process.env.INTELEPHENSE_GLOBAL_STORAGE_PATH ??
          join(homedir(), '.config', 'intelephense'),
        clearCache: false,
        isVscode: false,
        ...options,
      },
    };
  }

  workspaceConfiguration(items: unknown[]): unknown[] {
    return items.map(() => ({ diagnostics: { run: 'onSave' } }));
  }

  handleNotification(method: string, _params: unknown, state: ServerState): boolean {
    if (method === 'indexingStarted') {
      logger.debug('[DEBUG IntelephenseAdapter] Indexing started\n');
      state.indexingStarted = true;
      state.indexingComplete = false;
      return true;
    }
    if (method === 'indexingEnded') {
      logger.debug('[DEBUG IntelephenseAdapter] Indexing ended\n');
      state.indexingStarted = true;
      state.indexingComplete = true;
      const waiters = this.readinessWaiters.get(state);
      if (waiters) {
        for (const resolve of waiters) resolve();
        waiters.clear();
      }
      return true;
    }
    return false;
  }

  async waitForProjectReady(
    state: ServerState,
    _filePath: string,
    timeout: number
  ): Promise<boolean> {
    if (state.indexingComplete) return true;
    return new Promise<boolean>((resolve) => {
      let waiters = this.readinessWaiters.get(state);
      if (!waiters) {
        waiters = new Set();
        this.readinessWaiters.set(state, waiters);
      }
      const ready = () => {
        clearTimeout(timer);
        waiters?.delete(ready);
        resolve(true);
      };
      const timer = setTimeout(() => {
        waiters?.delete(ready);
        resolve(false);
      }, timeout);
      waiters.add(ready);
    });
  }

  async pullDiagnostics(
    state: ServerState,
    filePath: string,
    timeout: number
  ): Promise<Diagnostic[] | null> {
    const uri = pathToUri(filePath);
    const revision = state.diagnosticsCache.revision(uri);
    state.transport.sendNotification('textDocument/didSave', {
      textDocument: { uri },
    });
    const updated = await state.diagnosticsCache.waitForUpdate(uri, revision, timeout);
    return updated ? (state.diagnosticsCache.get(uri) ?? []) : null;
  }

  getTimeout(method: string): number | undefined {
    // Intelephense can be slow while the workspace index is still building.
    const timeouts: Record<string, number> = {
      'project/readiness': 60000, // 60 seconds
      'workspace/symbol': 60000, // 60 seconds
      'textDocument/references': 60000, // 60 seconds
      'textDocument/rename': 60000, // 60 seconds
      'textDocument/definition': 45000, // 45 seconds
      'textDocument/diagnostic': 15000, // didSave -> fresh publishDiagnostics
      'textDocument/documentSymbol': 45000, // 45 seconds
    };
    return timeouts[method];
  }
}
