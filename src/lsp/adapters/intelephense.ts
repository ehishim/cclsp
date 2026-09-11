import { logger } from '../../logger.js';
import type { LSPServerConfig } from '../../types.js';
import type { ServerAdapter, ServerState } from '../types.js';

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

  getTimeout(method: string): number | undefined {
    // Intelephense can be slow while the workspace index is still building.
    const timeouts: Record<string, number> = {
      'project/readiness': 60000, // 60 seconds
      'workspace/symbol': 60000, // 60 seconds
      'textDocument/references': 60000, // 60 seconds
      'textDocument/rename': 60000, // 60 seconds
      'textDocument/definition': 45000, // 45 seconds
      'textDocument/documentSymbol': 45000, // 45 seconds
    };
    return timeouts[method];
  }
}
