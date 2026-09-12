// The cclsp-hub daemon: a Unix-socket server that owns the RootPool, routes tool
// calls to the right warm cclsp child, and evicts idle roots. Started detached by
// the CLI on first use (see client.ts), or directly via `cclsp-hub --daemon`.

import { existsSync, mkdirSync, readFileSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { dirname, isAbsolute, resolve } from 'node:path';

import {
  IDLE_DAEMON_MS,
  IDLE_ROOT_MS,
  PID_PATH,
  RUNTIME_DIR,
  SOCKET_PATH,
} from './config.js';
import { RootPool, normalizeRoot, type RoutedRoot, type ToolSchema } from './pool.js';
import { normalizeToolResult } from './tool-result.js';
import { type HubRequest, createLineReader, writeMessage } from './protocol.js';
import { acquireDaemonLock } from './startup-lock.js';

// Coerce raw string/bool flag values into the types cclsp's JSON schema expects.
function coerceParams(raw: Record<string, unknown>, schema: ToolSchema | undefined): Record<string, unknown> {
  const props: Record<string, any> = schema?.inputSchema?.properties ?? {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) {
    const t = props[k]?.type;
    if (t === 'number' || t === 'integer') {
      const n = Number(v);
      out[k] = Number.isNaN(n) ? v : n;
    } else if (t === 'boolean') {
      out[k] = v === true || v === 'true' || v === '1';
    } else if (t === 'array') {
      out[k] = typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v;
    } else {
      out[k] = v;
    }
  }
  return out;
}

const FILESYSTEM_PARAMS = new Set(['file_path', 'path', 'old_path', 'new_path']);

function resolveFilesystemParams(
  raw: Record<string, unknown>,
  cwd: string,
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(raw).map(([key, value]) => {
    if (!FILESYSTEM_PARAMS.has(key) || typeof value !== 'string' || value.length === 0) {
      return [key, value];
    }
    return [key, isAbsolute(value) ? value : resolve(cwd, value)];
  }));
}

function withRoutingMetadata(result: unknown, route: RoutedRoot): unknown {
  if (!result || typeof result !== 'object') return result;
  const envelope = result as Record<string, unknown>;
  const structured = envelope.structuredContent && typeof envelope.structuredContent === 'object'
    ? envelope.structuredContent as Record<string, unknown>
    : {};
  return {
    ...envelope,
    structuredContent: {
      ...structured,
      detectedProjectRoot: route.detectedRoot,
      servingProjectRoot: route.servingRoot,
    },
  };
}

async function dispatchTool(pool: RootPool, args: Record<string, unknown>): Promise<unknown> {
  const name = String(args.name);
  const signal = args.signal instanceof AbortSignal ? args.signal : undefined;
  const cwd = typeof args.cwd === 'string' ? resolve(args.cwd) : process.cwd();
  const rawParams = resolveFilesystemParams((args.params ?? {}) as Record<string, unknown>, cwd);
  const explicitRoot = args.root
    ? (isAbsolute(String(args.root)) ? String(args.root) : resolve(cwd, String(args.root)))
    : undefined;

  // A file/path is the strongest routing intent; target-less workspace calls use
  // the caller cwd. Explicit --root remains the only exact-root override.
  const pathArg =
    typeof rawParams.file_path === 'string'
      ? (rawParams.file_path as string)
      : typeof rawParams.path === 'string'
        ? (rawParams.path as string)
        : cwd;

  if (name === 'restart_server') {
    const entries = pool.servingRoots(explicitRoot ?? cwd);
    if (entries.length === 0) {
      return { outcome: 'unavailable', provider: 'none', code: 'HUB_NO_SERVING_ROOT',
        text: `No warm serving root for ${explicitRoot ?? cwd}.`,
        recovery: 'Run a file-bearing semantic action in the intended project first.' };
    }
    const schema = (await pool.describe()).find((tool) => tool.name === name);
    const params = coerceParams(rawParams, schema);
    const answers = await Promise.all(entries.map(async (entry) => ({
      root: entry.root,
      result: normalizeToolResult(await pool.callTool(entry, name, params, signal), { defaultProvider: 'lsp' }),
    })));
    const failed = answers.some(({ result }) => (result as { outcome?: string }).outcome !== 'ok');
    return { outcome: failed ? 'unavailable' : 'ok', provider: 'lsp', roots: answers,
      text: answers.map(({ root, result }) => `${root}\n${(result as { text?: string }).text ?? ''}`).join('\n\n'),
      shown: answers.length, total: answers.length };
  }

  let route: RoutedRoot;
  if (explicitRoot) {
    const detectedRoot = normalizeRoot(explicitRoot);
    const { entry, reused } = await pool.ensure(detectedRoot, { isolate: true });
    route = { entry, detectedRoot, servingRoot: entry.root, reused };
  } else {
    route = await pool.routeTarget(pathArg);
  }

  // We have a live child, so its (cached) schema is available for coercion + checks.
  const schemas = await pool.describe();
  const schema = schemas.find((t) => t.name === name);
  if (!schema) {
    // A mistyped command reaches here as a tool name; say so plainly instead of
    // failing later with routing vocabulary the caller never used.
    throw new Error(
      `unknown tool '${name}': run 'cclsp-hub describe' for the tool list or 'cclsp-hub --help' for daemon commands`,
    );
  }
  const params = coerceParams(rawParams, schema);
  const required: string[] = schema?.inputSchema?.required ?? [];
  const missing = required.filter((r) => params[r] === undefined || params[r] === '');
  if (missing.length) {
    throw new Error(`missing required parameter(s) for ${name}: ${missing.join(', ')}`);
  }
  const answer = await callThroughRoute(pool, route, name, params, pathArg, Boolean(explicitRoot), signal);
  const routed = withRoutingMetadata(answer, route);
  if (args.rawMcp === true) return routed;
  const defaultProvider = name === 'ast_search' || name === 'code_rewrite' ? 'tree-sitter' : 'lsp';
  return normalizeToolResult(routed, { defaultProvider });
}

/**
 * A language-server handshake failure, as opposed to a failure to answer this
 * particular question. It says the server serving this path cannot serve it at
 * all, which for a REUSED covering root is a fact about that root rather than
 * about the request.
 */
function isServerInitFailure(error: unknown): boolean {
  const text = error instanceof Error ? error.message : String(error ?? '');
  return text.includes('initialize failed');
}

/**
 * A tool failure arrives as an `isError` RESULT, not as a thrown error, so a
 * recovery that only catches exceptions never sees it.
 */
function resultInitFailure(result: unknown): boolean {
  if (!result || typeof result !== 'object') return false;
  const envelope = result as { isError?: unknown; content?: unknown };
  if (envelope.isError !== true) return false;
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const text = content
    .map((part) => (part && typeof part === 'object' ? String((part as { text?: unknown }).text ?? '') : ''))
    .join('\n');
  return isServerInitFailure(text);
}

/**
 * Call through the routed root and defensively recover if a stale/racing route
 * still serves a nested request from a warm covering root that cannot serve it.
 * Normal routing discovers the owner before warm reuse; this fallback retires the
 * mismatched coverage and retries on the target's dedicated root.
 *
 * `callerPinnedRoot` disables that recovery entirely. An explicit --root is an
 * exact override, so the root the caller NAMED is the one that must answer --
 * even for a nested target it turns out not to own. Retiring it would silently
 * redirect the call to a root the caller did not ask for, which is the same
 * misattribution defect in the opposite direction.
 */
export async function callThroughRoute(
  pool: Pick<RootPool, 'callTool' | 'markCoverageBroken' | 'ensure' | 'owningRoot'>,
  route: RoutedRoot,
  name: string,
  params: Record<string, unknown>,
  target?: string,
  callerPinnedRoot = false,
  signal?: AbortSignal,
): Promise<any> {
  const reusedRoot = route.entry.root;
  const absoluteTarget = target ? normalizeRoot(target) : null;
  let firstFailure: unknown;
  try {
    const result = await pool.callTool(route.entry, name, params, signal);
    if (callerPinnedRoot || !route.reused || !resultInitFailure(result)) return result;
    firstFailure = result;
  } catch (error) {
    if (callerPinnedRoot || !route.reused || !isServerInitFailure(error)) throw error;
    firstFailure = error;
  }

  {
    // Re-discover after a failed reused route because project markers may have
    // changed between initial routing and provider initialization.
    const owning = absoluteTarget ? pool.owningRoot(absoluteTarget) : route.detectedRoot;
    // The serving root IS the target's own project, so its failure is the answer:
    // there is no narrower root to fall back to and nothing to retire.
    if (!owning || owning === reusedRoot) {
      if (firstFailure instanceof Error) throw firstFailure;
      return firstFailure;
    }
    route.detectedRoot = owning;
    pool.markCoverageBroken(route.entry);
    const { entry: dedicated } = await pool.ensure(owning, { isolate: true });
    route.entry = dedicated;
    route.servingRoot = dedicated.root;
    route.reused = false;
    const context = `retried on a dedicated root for ${route.detectedRoot} after the covering root ${reusedRoot} could not serve it`;
    try {
      const retried = await pool.callTool(dedicated, name, params, signal);
      // The DEDICATED root's own failure is the one that describes this request;
      // the covering root's is context. Reporting the retired root's message
      // instead would misattribute the failure -- the defect this retry exists to
      // stop -- so the dedicated result is returned and only annotated.
      if (resultInitFailure(retried)) return annotateFailure(retried, context);
      return retried;
    } catch (retryError) {
      const detail = retryError instanceof Error ? retryError.message : String(retryError);
      throw new Error(detail.includes(context) ? detail : `${detail} (${context})`);
    }
  }
}

/** Keep the failing envelope intact and append why it was reached. */
function annotateFailure(result: unknown, context: string): unknown {
  if (!result || typeof result !== 'object') return result;
  const envelope = result as { content?: unknown };
  const content = Array.isArray(envelope.content) ? envelope.content : [];
  const annotated = content.map((part, index) => (
    index === 0 && part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string'
      ? { ...(part as Record<string, unknown>), text: `${(part as { text: string }).text} (${context})` }
      : part
  ));
  return { ...(result as Record<string, unknown>), content: annotated.length > 0 ? annotated : content };
}

/** Owns exact request-to-cancellation correlation until provider settlement. */
export class InFlightRequests {
  private readonly controllers = new Map<string | number, AbortController>();

  start(id: string | number): AbortController {
    if (this.controllers.has(id)) throw new Error(`HUB_DUPLICATE_REQUEST_ID: ${id}`);
    const controller = new AbortController();
    this.controllers.set(id, controller);
    return controller;
  }

  cancel(id: string | number | undefined): boolean {
    if (id === undefined) return false;
    const controller = this.controllers.get(id);
    if (!controller || controller.signal.aborted) return false;
    controller.abort(new Error('Hub request cancelled by caller'));
    return true;
  }

  finish(id: string | number, controller: AbortController): void {
    if (this.controllers.get(id) === controller) this.controllers.delete(id);
  }

  get size(): number {
    return this.controllers.size;
  }
}

export async function runDaemon(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  // An overridden socket may live outside RUNTIME_DIR, and bind() will not create
  // its parent.
  mkdirSync(dirname(SOCKET_PATH), { recursive: true });
  const releaseLock = acquireDaemonLock(PID_PATH);
  if (!releaseLock) {
    // Refusing silently leaves the caller with only a client-side "timed out
    // waiting for its socket", which names the socket rather than the lock that
    // actually refused, and reads as a broken build rather than a live holder.
    let holder = 'unknown';
    try {
      holder = readFileSync(PID_PATH, 'utf8').trim() || 'unknown';
    } catch {
      // The holder released the lock between the failed acquire and this read.
    }
    process.stderr.write(
      `cclsp-hub daemon not started: startup lock ${PID_PATH} is held by pid ${holder}.\n` +
        `That daemon serves ${SOCKET_PATH}. Shut it down, or set CCLSP_HUB_SOCKET to a different path to run an isolated daemon beside it.\n`,
    );
    return;
  }
  let cleaned = false;
  const cleanupRuntime = () => {
    if (cleaned) return;
    cleaned = true;
    try { if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH); } catch {}
    releaseLock();
  };
  // Only the startup-lock owner may clear a socket left by a crashed daemon.
  if (existsSync(SOCKET_PATH)) {
    try {
      unlinkSync(SOCKET_PATH);
    } catch {
      // ignore
    }
  }

  const pool = new RootPool();
  const startedAt = Date.now();
  let lastActivity = Date.now();

  const inFlight = new InFlightRequests();
  const server: Server = createServer((sock: Socket) => {
    sock.on('error', () => sock.destroy());
    sock.on(
      'data',
      createLineReader((req: HubRequest) => {
        lastActivity = Date.now();
        void handle(req, sock);
      }),
    );
  });

  async function handle(req: HubRequest, sock: Socket): Promise<void> {
    const reply = (ok: boolean, result?: unknown, error?: string) =>
      writeMessage(sock, { id: req.id, ok, result, error });
    const args = req.args ?? {};
    if (req.cmd === 'cancel') {
      const cancelId = req.cancelId ?? (typeof args.cancelId === 'string' || typeof args.cancelId === 'number'
        ? args.cancelId
        : undefined);
      reply(true, { cancelled: inFlight.cancel(cancelId), requestId: cancelId });
      return;
    }
    let controller: AbortController | undefined;
    try {
      if (req.cmd === 'tool') controller = inFlight.start(req.id);
      switch (req.cmd) {
        case 'status':
          reply(true, {
            running: true,
            pid: process.pid,
            socket: SOCKET_PATH,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
            inFlightRequests: inFlight.size,
            roots: pool.list().map((e) => e.root),
          });
          break;
        case 'describe':
          reply(true, { tools: await pool.describe() });
          break;
        case 'ensure-root': {
          const { entry: e, reused } = await pool.ensure(String(args.root), {
            isolate: args.isolate === true,
          });
          reply(true, {
            root: e.root,
            requested: normalizeRoot(String(args.root)),
            reused,
            pid: e.pid,
            startedAt: e.startedAt,
          });
          break;
        }
        case 'list-roots':
          reply(true, {
            roots: pool.list().map((e) => ({
              root: e.root,
              pid: e.pid,
              ageSec: Math.round((Date.now() - e.startedAt) / 1000),
              idleSec: Math.round((Date.now() - e.lastUsed) / 1000),
            })),
          });
          break;
        case 'stop-root':
          reply(true, { stopped: await pool.stop(String(args.root)) });
          break;
        case 'restart-root': {
          const entries = pool.servingRoots(String(args.root));
          if (entries.length === 0) throw new Error('HUB_NO_SERVING_ROOT: no warm root serves the requested path');
          const roots = [];
          for (const entry of entries) {
            const restarted = await pool.restart(entry.root);
            roots.push({ root: restarted.root, pid: restarted.pid });
          }
          reply(true, { ...roots[0], roots });
          break;
        }
        case 'tool':
          reply(true, await dispatchTool(pool, { ...args, signal: controller!.signal }));
          break;
        case 'shutdown':
          reply(true, { stopped: true });
          await pool.stopAll();
          server.close();
          setTimeout(() => {
            cleanupRuntime();
            process.exit(0);
          }, 50);
          break;
        default:
          reply(false, undefined, `unknown command: ${req.cmd}`);
      }
    } catch (err) {
      reply(false, undefined, err instanceof Error ? err.message : String(err));
    } finally {
      if (controller) inFlight.finish(req.id, controller);
    }
  }

  // Idle eviction: drop roots unused for too long; optionally self-exit when idle.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const e of pool.list()) {
      if (now - e.lastUsed > IDLE_ROOT_MS) void pool.stop(e.root);
    }
    if (IDLE_DAEMON_MS > 0 && pool.list().length === 0 && now - lastActivity > IDLE_DAEMON_MS) {
      void pool.stopAll().then(() => {
        server.close();
        cleanupRuntime();
        process.exit(0);
      });
    }
  }, 30_000);
  sweeper.unref();

  const shutdown = () => {
    void pool.stopAll().finally(() => {
      cleanupRuntime();
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>((res, rej) => {
    server.once('error', (error) => {
      cleanupRuntime();
      rej(error);
    });
    server.listen(SOCKET_PATH, res);
  });
}
