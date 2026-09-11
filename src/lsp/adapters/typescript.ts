import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../../logger.js';
import type { LSPServerConfig } from '../../types.js';
import { pathToUri } from '../../utils.js';
import type { Diagnostic, InitializeParams, ServerAdapter, ServerState } from '../types.js';

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
  private readonly projectKeys = new WeakMap<ServerState, Map<string, string>>();
  private readonly readyProjects = new WeakMap<ServerState, Set<string>>();
  private readonly readinessInFlight = new WeakMap<ServerState, Map<string, Promise<boolean>>>();
  private readonly diagnosticSlots = new WeakMap<
    ServerState,
    { active: number; waiting: Array<() => void> }
  >();

  matches(config: LSPServerConfig): boolean {
    return config.command.some((c: string) => c.includes('typescript-language-server'));
  }

  /**
   * Measured on typescript-language-server 4.x/5.x: `workspaceSymbol` sends
   * `navto` with `file: documents.files[0]`, and `files[0]` is the document the
   * last request touched. tsserver then searches only that file's project, so
   * one query answers for one project and reads as absence for every other.
   */
  workspaceSymbolScope(state: ServerState, filePath: string): string {
    return this.projectKey(state, filePath);
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

  async waitForProjectReady(
    state: ServerState,
    filePath: string,
    timeout: number
  ): Promise<boolean> {
    const project = this.projectKey(state, filePath);
    const ready = this.readyProjects.get(state);
    if (ready?.has(project)) return true;
    let inFlight = this.readinessInFlight.get(state);
    if (!inFlight) {
      inFlight = new Map();
      this.readinessInFlight.set(state, inFlight);
    }
    const current = inFlight.get(project);
    if (current) return current;

    const run = (async () => {
      const capability = state.serverCapabilities.executeCommandProvider as
        | { commands?: unknown }
        | undefined;
      if (
        !Array.isArray(capability?.commands) ||
        !capability.commands.includes('typescript.tsserverRequest')
      ) {
        return false;
      }
      try {
        const reply = (await state.transport.sendRequest(
          'workspace/executeCommand',
          {
            command: 'typescript.tsserverRequest',
            arguments: [
              'projectInfo',
              { file: filePath, needFileNameList: false },
              { executionTarget: 0 },
            ],
          },
          timeout
        )) as { success?: boolean; body?: unknown; message?: string } | undefined;
        const body = reply?.body as
          | { configFileName?: unknown; languageServiceDisabled?: unknown }
          | undefined;
        if (
          reply?.success !== true ||
          typeof body?.configFileName !== 'string' ||
          body.languageServiceDisabled !== false
        ) {
          logger.debug(
            `[TypeScriptAdapter] Project readiness request failed: ${reply?.message ?? 'missing enabled project confirmation'}\n`
          );
          return false;
        }
        const confirmed = this.readyProjects.get(state) ?? new Set<string>();
        confirmed.add(project);
        this.readyProjects.set(state, confirmed);
        return true;
      } catch (error) {
        logger.debug(`[TypeScriptAdapter] Project readiness request failed: ${error}\n`);
        return false;
      }
    })();

    inFlight.set(project, run);
    try {
      return await run;
    } finally {
      inFlight.delete(project);
    }
  }

  private projectKey(state: ServerState, filePath: string): string {
    const fileDirectory = resolve(dirname(filePath));
    let cached = this.projectKeys.get(state);
    const known = cached?.get(fileDirectory);
    if (known) return known;

    const configuredRoot = state.config.rootDir ? resolve(state.config.rootDir) : fileDirectory;
    let current = fileDirectory;
    let project = configuredRoot;
    while (true) {
      if (
        existsSync(join(current, 'tsconfig.json')) ||
        existsSync(join(current, 'jsconfig.json'))
      ) {
        project = current;
        break;
      }
      if (current === configuredRoot) break;
      const parent = dirname(current);
      if (parent === current || !current.startsWith(`${configuredRoot}/`)) break;
      current = parent;
    }
    cached ??= new Map();
    cached.set(fileDirectory, project);
    this.projectKeys.set(state, cached);
    return project;
  }

  async pullDiagnostics(
    state: ServerState,
    filePath: string,
    timeout: number
  ): Promise<Diagnostic[] | null> {
    const capability = state.serverCapabilities.executeCommandProvider as
      | { commands?: unknown }
      | undefined;
    if (
      !Array.isArray(capability?.commands) ||
      !capability.commands.includes('typescript.tsserverRequest')
    )
      return null;
    let slots = this.diagnosticSlots.get(state);
    if (!slots) {
      slots = { active: 0, waiting: [] };
      this.diagnosticSlots.set(state, slots);
    }
    if (slots.active >= 4) {
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const index = slots.waiting.indexOf(wake);
          if (index >= 0) slots.waiting.splice(index, 1);
          reject(new Error('LSP_REQUEST_INVALID_RESPONSE: diagnostic request queue timed out'));
        }, timeout);
        slots.waiting.push(wake);
      });
    } else slots.active++;
    try {
      const diagnostics: Diagnostic[] = [];
      for (const command of [
        'syntacticDiagnosticsSync',
        'semanticDiagnosticsSync',
        'suggestionDiagnosticsSync',
      ]) {
        const reply = (await state.transport.sendRequest(
          'workspace/executeCommand',
          {
            command: 'typescript.tsserverRequest',
            arguments: [
              command,
              { file: filePath, includeLinePosition: true },
              { executionTarget: 0 },
            ],
          },
          timeout
        )) as { success?: boolean; body?: unknown; message?: string } | undefined;
        if (reply?.success !== true || !Array.isArray(reply.body)) {
          throw new Error(
            `LSP_REQUEST_INVALID_RESPONSE: ${command}: ${reply?.message ?? 'missing diagnostic array'}`
          );
        }
        for (const value of reply.body) {
          const item = value as {
            message: string;
            category: string;
            code: number;
            startLocation?: { line: number; offset: number };
            endLocation?: { line: number; offset: number };
            reportsUnnecessary?: boolean;
            reportsDeprecated?: boolean;
            relatedInformation?: Array<{
              message: string;
              span?: {
                file: string;
                start: { line: number; offset: number };
                end: { line: number; offset: number };
              };
            }>;
          };
          if (!item.startLocation || !item.endLocation)
            throw new Error('LSP_REQUEST_INVALID_RESPONSE: missing diagnostic locations');
          diagnostics.push({
            range: {
              start: {
                line: item.startLocation.line - 1,
                character: item.startLocation.offset - 1,
              },
              end: { line: item.endLocation.line - 1, character: item.endLocation.offset - 1 },
            },
            message: item.message,
            code: item.code,
            source: 'typescript',
            ...(item.reportsUnnecessary || item.reportsDeprecated
              ? {
                  tags: [
                    ...(item.reportsUnnecessary ? [1 as const] : []),
                    ...(item.reportsDeprecated ? [2 as const] : []),
                  ],
                }
              : {}),
            ...(item.relatedInformation?.length
              ? {
                  relatedInformation: item.relatedInformation.flatMap((related) => {
                    if (!related.span) return [];
                    return [
                      {
                        message: related.message,
                        location: {
                          uri: pathToUri(related.span.file),
                          range: {
                            start: {
                              line: related.span.start.line - 1,
                              character: related.span.start.offset - 1,
                            },
                            end: {
                              line: related.span.end.line - 1,
                              character: related.span.end.offset - 1,
                            },
                          },
                        },
                      },
                    ];
                  }),
                }
              : {}),
            severity:
              item.category === 'error'
                ? 1
                : item.category === 'warning'
                  ? 2
                  : item.category === 'suggestion'
                    ? 4
                    : 3,
          });
        }
      }
      return diagnostics;
    } finally {
      const next = slots.waiting.shift();
      if (next) next();
      else slots.active--;
    }
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

    const initializationOptions =
      params.initializationOptions && typeof params.initializationOptions === 'object'
        ? (params.initializationOptions as Record<string, unknown>)
        : {};
    const pluginRoot = fileURLToPath(new URL('./plugins/', import.meta.url));
    const pluginPath = join(pluginRoot, 'node_modules/cclsp-full-display/index.js');
    const plugins = Array.isArray(initializationOptions.plugins)
      ? initializationOptions.plugins
      : [];
    return {
      ...params,
      ...(existsSync(pluginPath)
        ? {
            initializationOptions: {
              ...initializationOptions,
              plugins: [
                ...plugins,
                {
                  name: 'cclsp-full-display',
                  location: pluginRoot,
                  languages: ['typescript', 'javascript'],
                },
              ],
            },
          }
        : {}),
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
