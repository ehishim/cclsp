import { logger } from '../../logger.js';
import type { LSPServerConfig } from '../../types.js';
import type { InitializeParams, ServerAdapter, ServerState } from '../types.js';

/**
 * The work-done progress tsserver reports while it builds the project graph.
 * Measured against typescript-language-server 5.3.0; matched loosely because the
 * wording is display text, and an unrecognised title simply leaves readiness to
 * the caller's budget rather than asserting it falsely.
 */
const PROJECT_LOAD_TITLE = /initializing js\/ts language features/i;

/**
 * Adapter for typescript-language-server.
 *
 * Declares the client capability that makes call hierarchy available at all. A
 * server advertises a provider only when the client has declared support, so an
 * undeclared `callHierarchy` makes `prepareCallHierarchy` report as unsupported —
 * a fact about the handshake that reads exactly like a fact about the language,
 * and sends the caller to text search for "who calls this".
 *
 * Also turns tsserver's project-graph load into the readiness fact
 * `waitForWorkspaceSymbolReady` already knows how to wait for. Until a project
 * graph is built, `workspace/symbol` answers from what happens to be loaded, so a
 * query for a symbol that exists can return nothing and read as absence. The
 * server announces the load as work-done progress and cclsp already answers the
 * `window/workDoneProgress/create` request that enables it — the notifications
 * simply had no consumer.
 *
 * Deliberately does NOT supply `tsserver.path`. The server's own discovery was
 * measured working through a symlinked `node_modules`, so no defect forces it;
 * the failure that looked like broken discovery came from Hub covering-root reuse
 * serving a nested request from a parent root that has no TypeScript.
 */
export class TypeScriptAdapter implements ServerAdapter {
  readonly name = 'typescript';

  /** Progress tokens seen beginning a project load, per server. */
  private readonly loadTokens = new WeakMap<ServerState, Set<string>>();

  matches(config: LSPServerConfig): boolean {
    return config.command.some((c: string) => c.includes('typescript-language-server'));
  }

  isWorkspaceIndexingServer(): boolean {
    return true;
  }

  handleNotification(method: string, params: unknown, state: ServerState): boolean {
    if (method !== '$/progress') return false;
    const payload = params as { token?: unknown; value?: { kind?: unknown; title?: unknown } };
    const token = typeof payload?.token === 'string' ? payload.token : null;
    const kind = payload?.value?.kind;
    if (!token) return false;

    let tokens = this.loadTokens.get(state);
    if (kind === 'begin' && PROJECT_LOAD_TITLE.test(String(payload.value?.title ?? ''))) {
      if (!tokens) {
        tokens = new Set();
        this.loadTokens.set(state, tokens);
      }
      tokens.add(token);
      state.indexingStarted = true;
      state.indexingComplete = false;
      logger.debug('[TypeScriptAdapter] Project load started\n');
      return true;
    }
    // Only a token we saw BEGIN a project load may declare one complete; other
    // progress (a rename, a code action) must not be read as readiness.
    if (kind === 'end' && tokens?.delete(token)) {
      if (tokens.size === 0) {
        state.indexingComplete = true;
        logger.debug('[TypeScriptAdapter] Project load complete\n');
      }
      return true;
    }
    return false;
  }

  customizeInitializeParams(params: InitializeParams): InitializeParams {
    const capabilities =
      typeof params.capabilities === 'object' && params.capabilities !== null
        ? (params.capabilities as Record<string, unknown>)
        : {};
    const textDocument =
      typeof capabilities.textDocument === 'object' && capabilities.textDocument !== null
        ? (capabilities.textDocument as Record<string, unknown>)
        : {};

    return {
      ...params,
      capabilities: {
        ...capabilities,
        textDocument: {
          ...textDocument,
          callHierarchy: { dynamicRegistration: false },
        },
      },
    };
  }
}
