// The cclsp-hub daemon: a Unix-socket server that owns the RootPool, routes tool
// calls to the right warm cclsp child, and evicts idle roots. Started detached by
// the CLI on first use (see client.ts), or directly via `cclsp-hub --daemon`.

import { existsSync, mkdirSync, unlinkSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import { isAbsolute, resolve } from 'node:path';

import {
  IDLE_DAEMON_MS,
  IDLE_ROOT_MS,
  PID_PATH,
  RUNTIME_DIR,
  SOCKET_PATH,
} from './config.js';
import { type RootEntry, RootPool, normalizeRoot, type RoutedRoot, type ToolSchema } from './pool.js';
import { markColdIndexResult, normalizeToolResult } from './tool-result.js';
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

  let route: RoutedRoot;
  if (explicitRoot) {
    const detectedRoot = normalizeRoot(explicitRoot);
    const { entry, reused } = await pool.ensure(detectedRoot);
    route = { entry, detectedRoot, servingRoot: entry.root, reused };
  } else {
    route = await pool.routeTarget(pathArg);
  }
  const entry: RootEntry = route.entry;

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
  const routed = withRoutingMetadata(await pool.callTool(entry, name, params), route);
  if (args.rawMcp === true) return routed;
  const defaultProvider = name === 'ast_search' || name === 'code_rewrite' ? 'tree-sitter' : 'lsp';
  const normalized = normalizeToolResult(routed, { defaultProvider });
  return markColdIndexResult(normalized, name, Date.now() - entry.startedAt);
}

export async function runDaemon(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  const releaseLock = acquireDaemonLock(PID_PATH);
  if (!releaseLock) return;
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
    try {
      switch (req.cmd) {
        case 'status':
          reply(true, {
            running: true,
            pid: process.pid,
            socket: SOCKET_PATH,
            uptimeSec: Math.round((Date.now() - startedAt) / 1000),
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
          const e = await pool.restart(String(args.root));
          reply(true, { root: e.root, pid: e.pid });
          break;
        }
        case 'tool':
          reply(true, await dispatchTool(pool, args));
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
