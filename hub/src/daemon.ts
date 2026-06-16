// The cclsp-hub daemon: a Unix-socket server that owns the RootPool, routes tool
// calls to the right warm cclsp child, and evicts idle roots. Started detached by
// the CLI on first use (see client.ts), or directly via `cclsp-hub --daemon`.

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { type Server, type Socket, createServer } from 'node:net';
import {
  IDLE_DAEMON_MS,
  IDLE_ROOT_MS,
  PID_PATH,
  RUNTIME_DIR,
  SOCKET_PATH,
} from './config.js';
import { type RootEntry, RootPool, type ToolSchema } from './pool.js';
import { type HubRequest, createLineReader, writeMessage } from './protocol.js';

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

async function dispatchTool(pool: RootPool, args: Record<string, unknown>): Promise<unknown> {
  const name = String(args.name);
  const rawParams = (args.params ?? {}) as Record<string, unknown>;
  const explicitRoot = args.root ? String(args.root) : undefined;

  // The param that decides routing — file_path for most tools, path for batch.
  const pathArg =
    typeof rawParams.file_path === 'string'
      ? (rawParams.file_path as string)
      : typeof rawParams.path === 'string'
        ? (rawParams.path as string)
        : undefined;

  // Resolve the target root FIRST (needs only the raw path), so the explicit-only
  // contract is enforced without spawning anything.
  let entry: RootEntry;
  if (explicitRoot) {
    const e = pool.get(explicitRoot);
    if (!e) {
      throw new Error(`root not registered: ${explicitRoot}\n  run: cclsp-hub ensure-root ${explicitRoot}`);
    }
    entry = e;
  } else if (pathArg) {
    const e = pool.resolveRootForFile(pathArg);
    if (!e) {
      const active = pool.list().map((r) => r.root).join(', ') || 'none';
      throw new Error(
        `no registered root owns ${pathArg}\n  run: cclsp-hub ensure-root <project-root>\n  active roots: ${active}`,
      );
    }
    entry = e;
  } else {
    const roots = pool.list();
    const first = roots[0];
    if (roots.length === 1 && first) {
      entry = first;
    } else {
      const active = roots.map((r) => r.root).join(', ') || 'none';
      throw new Error(`tool '${name}' has no file to route by; pass --root <path>\n  active roots: ${active}`);
    }
  }

  // We have a live child, so its (cached) schema is available for coercion + checks.
  const schemas = await pool.describe();
  const schema = schemas.find((t) => t.name === name);
  const params = coerceParams(rawParams, schema);
  const required: string[] = schema?.inputSchema?.required ?? [];
  const missing = required.filter((r) => params[r] === undefined || params[r] === '');
  if (missing.length) {
    throw new Error(`missing required parameter(s) for ${name}: ${missing.join(', ')}`);
  }
  return pool.callTool(entry, name, params);
}

export async function runDaemon(): Promise<void> {
  mkdirSync(RUNTIME_DIR, { recursive: true });
  // Clear a stale socket left by a crashed daemon.
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
          const e = await pool.ensure(String(args.root));
          reply(true, { root: e.root, pid: e.pid, startedAt: e.startedAt });
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
          setTimeout(() => process.exit(0), 50);
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
        process.exit(0);
      });
    }
  }, 30_000);
  sweeper.unref();

  const shutdown = () => {
    void pool.stopAll().finally(() => {
      try {
        if (existsSync(SOCKET_PATH)) unlinkSync(SOCKET_PATH);
      } catch {
        // ignore
      }
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await new Promise<void>((res, rej) => {
    server.once('error', rej);
    server.listen(SOCKET_PATH, () => {
      try {
        writeFileSync(PID_PATH, String(process.pid));
      } catch {
        // ignore
      }
      res();
    });
  });
}
