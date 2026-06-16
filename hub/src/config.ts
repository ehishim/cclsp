// Runtime configuration for cclsp-hub: filesystem locations and lifecycle knobs.
// Everything is overridable via environment variables so the same build behaves
// correctly in a dev container, a CI runner, or a developer laptop.

import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

export const VERSION = '0.1.0';

function runtimeDir(): string {
  // XDG_RUNTIME_DIR is the right home for ephemeral sockets/pids; fall back to tmp.
  const xdg = process.env.XDG_RUNTIME_DIR;
  const base = xdg && xdg.length > 0 ? xdg : tmpdir();
  return join(base, 'cclsp-hub');
}

function intEnv(name: string, def: number): number {
  const v = process.env[name];
  if (!v) return def;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}


export const RUNTIME_DIR = runtimeDir();
export const SOCKET_PATH = process.env.CCLSP_HUB_SOCKET || join(RUNTIME_DIR, 'daemon.sock');
export const PID_PATH = join(RUNTIME_DIR, 'daemon.pid');

// The built cclsp MCP server entry the daemon spawns (one child per root).
export const CCLSP_ENTRY = process.env.CCLSP_HUB_ENTRY || '/workspace/cclsp/dist/index.js';

// cclsp server-config (extensions -> language server). A `rootDir: "."` in this
// file resolves to each child's cwd (= the registered root), so a single config
// file serves every root.
export const CCLSP_CONFIG_PATH =
  process.env.CCLSP_HUB_CONFIG ||
  process.env.CCLSP_CONFIG_PATH ||
  join(homedir(), '.config/claude/cclsp.json');

// Lifecycle tunables.
export const MAX_ROOTS = intEnv('CCLSP_HUB_MAX_ROOTS', 30);
export const IDLE_ROOT_MS = intEnv('CCLSP_HUB_IDLE_ROOT_SEC', 30 * 60) * 1000;
// 0 = daemon never self-exits; otherwise exit after this long with zero roots.
export const IDLE_DAEMON_MS = intEnv('CCLSP_HUB_IDLE_DAEMON_SEC', 0) * 1000;
// Generous default: a cold language-server index on the first real call is slow.
export const TOOL_TIMEOUT_MS = intEnv('CCLSP_HUB_TOOL_TIMEOUT_SEC', 180) * 1000;

// NOTE: diagnostics-batch file limits are NOT hub vars. They live in cclsp core
// (CCLSP_MAX_FILES_DEFAULT / CCLSP_MAX_FILES_LIMIT) and reach the children via the
// inherited environment, so plain cclsp and the hub honor the same limits.
