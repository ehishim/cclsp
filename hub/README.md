# cclsp-hub

A multi-root **daemon + CLI** layered over the [cclsp](../) language-server MCP
server. It keeps **one warm cclsp instance (and its language servers) per project
root**, shared by every caller, and exposes all of cclsp's tools as a plain
command-line program — so any agent, from any working directory, can do
go-to-definition / find-references / diagnostics / rename without speaking MCP and
without paying a cold language-server start on every call.

```
  agent A ─┐                          ┌──────────── cclsp-hub daemon (one per machine/user) ──────────┐
  agent B ─┼─ cclsp-hub <cmd> ──UDS──▶│  router  (file path → owning root)                            │
  agent C ─┘  (thin client, any cwd)  │   ├─ /workspace/app      → cclsp #1 (stdio) → tsserver         │
                                      │   ├─ /workspace/api      → cclsp #2 (stdio) → tsserver         │
                                      │   └─ /workspace/legacy   → cclsp #3 (stdio) → intelephense      │
                                      │  lifecycle: ensure / list / stop / restart · LRU + idle evict   │
                                      └─────────────────────────────────────────────────────────────────┘
```

## Why

cclsp is a stdio MCP server that spawns a real language server (`tsserver`,
`intelephense`, …) rooted at its working directory and indexes the project into
memory. That makes it **stateful and root-bound**:

- Driving cclsp per-call (e.g. spawning it fresh for every CLI invocation) pays
  the full language-server cold-start + re-index **on every query** — unusable.
- Running it per-agent means N agents = N indexes of the same repo.

cclsp-hub solves both: it runs cclsp **once per root** behind a long-lived daemon,
keeps it warm, and multiplexes every caller onto the right instance.

## How it works

- **Daemon** — a background process listening on a Unix domain socket. It owns a
  pool of cclsp children, one per registered root, each spawned over stdio with
  `cwd = <root>` (so cclsp's `rootDir: "."` lands the language servers on that
  project) and `CCLSP_PRELOAD=1` (warm immediately).
- **Children** — cclsp is treated as a black box and driven over **MCP JSON-RPC
  on stdio**. No coupling to cclsp internals; behavior tracks cclsp exactly.
- **CLI** — a feather-weight client. It connects to the socket (auto-starting the
  daemon the first time), sends one request, prints the result. Tool subcommands
  are friendly aliases over cclsp's tools; flags map to tool parameters and are
  coerced to the right types from cclsp's own JSON schema.
- **Router** — every code-intelligence call carries a file; the daemon routes it
  to the registered root that is the **longest path-prefix** of that file.

## Install / build

The hub shares cclsp's dependencies (`@modelcontextprotocol/sdk` is resolved from
the parent `node_modules`). `dist/` is generated and **not** committed (same as
cclsp), so build it once:

```bash
cd /workspace/cclsp
bun install                 # if you haven't already (installs the SDK)
cd hub && bun run build     # → hub/dist/index.js
```

Install a wrapper on your `PATH`:

```bash
cat > ~/.local/bin/cclsp-hub <<'EOF'
#!/bin/sh
exec node /workspace/cclsp/hub/dist/index.js "$@"
EOF
chmod +x ~/.local/bin/cclsp-hub
```

## Quick start

```bash
# 1. Register the project you're working in (warms tsserver/intelephense)
cclsp-hub ensure-root /workspace/app

# 2. Use any tool — routed automatically by the file you pass
cclsp-hub definition  --file /workspace/app/src/db.ts --symbol-name connect
cclsp-hub references  --file /workspace/app/src/db.ts --symbol-name connect
cclsp-hub diagnostics --file /workspace/app/src/db.ts
cclsp-hub hover       --file /workspace/app/src/db.ts --line 42 --character 8

# 3. Inspect / manage
cclsp-hub roots
cclsp-hub status
```

## Commands

### Roots & daemon

| Command | Description |
|---|---|
| `ensure-root <path>` | Register a project root and warm its language servers (idempotent). |
| `list-roots` / `roots` | Show active roots with pid, age, idle time. |
| `stop-root <path>` | Tear down one root and its language servers. |
| `restart-root <path>` | Restart one root (recover a stale index). |
| `status` | Daemon status (pid, socket, uptime, roots). Does **not** start the daemon. |
| `shutdown` | Stop all roots and the daemon. |
| `describe` | List the available cclsp tools (and schemas with `--json`). |

### Code intelligence

Routed to the registered root that owns `--file`. Line/character are **1-indexed**.

| Command | Required | Optional |
|---|---|---|
| `definition` | `--file --symbol-name` | `--symbol-kind` |
| `references` | `--file --symbol-name` | `--symbol-kind --include-declaration` |
| `implementation` | `--file --line --character` | |
| `hover` | `--file --line --character` | |
| `diagnostics` | `--file` | |
| `diagnostics-batch` | `--path` | `--pattern --max-files` |
| `rename` | `--file --symbol-name --new-name` | `--symbol-kind --dry-run` |
| `rename-strict` | `--file --line --character --new-name` | `--dry-run` |
| `symbols` | `--query --root` | |
| `call-hierarchy` | `--file --line --character` | |
| `incoming-calls` | `--file --line --character` | |
| `outgoing-calls` | `--file --line --character` | |
| `restart-server` | `--root` | `--extensions ts,tsx` |
| `call <tool>` | — | `--params-json '{...}'` (raw passthrough) |

Flag notes:
- `--file` is sugar for `--file-path`; `--symbol` for `--symbol-name`.
- Parameter flags accept kebab- or snake-case (`--new-name` == `--new_name`).
- `--params-json '{...}'` merges raw JSON params (handy for arrays / new tools).

### Global options

| Option | Description |
|---|---|
| `--root <path>` | Force which registered root serves the call. |
| `--json` | Machine-readable JSON (works before or after the subcommand). |
| `-h`, `--help` | Top-level help, or `<command> --help` for a command's parameters. |
| `--version` | Print version. |

## Routing model (explicit-only)

A code-intelligence call only runs against a root you have **already registered**
with `ensure-root`. If a file isn't under any active root, the call fails with a
message telling you which root to add — nothing is auto-spawned:

```
$ cclsp-hub definition --file /workspace/other/x.ts --symbol-name foo
no registered root owns /workspace/other/x.ts
  run: cclsp-hub ensure-root <project-root>
  active roots: /workspace/app
```

When several roots match (nested roots), the **longest prefix** wins. Root-less
tools (`symbols`, `restart-server`) require `--root` unless exactly one root is
active.

## Output

- Default: cclsp's human-readable text.
- `--json`: the full MCP `CallToolResult` (`content`, `isError`, …). A tool error
  prints to stderr and exits non-zero.

## Configuration

| Env var | Default | Purpose |
|---|---|---|
| `CCLSP_HUB_ENTRY` | `/workspace/cclsp/dist/index.js` | cclsp server entry the daemon spawns. |
| `CCLSP_HUB_CONFIG` | `~/.config/claude/cclsp.json` | cclsp server config (extensions → language server). Falls back to `CCLSP_CONFIG_PATH`. |
| `CCLSP_HUB_MAX_ROOTS` | `30` | Max concurrent roots; least-recently-used is evicted past this. |
| `CCLSP_HUB_IDLE_ROOT_SEC` | `1800` | Evict a root after this long without use. |
| `CCLSP_HUB_IDLE_DAEMON_SEC` | `0` (never) | Self-exit after this long with zero roots. |
| `CCLSP_HUB_TOOL_TIMEOUT_SEC` | `180` | Per-call timeout (covers a cold first index). |
| `CCLSP_HUB_SOCKET` | `$XDG_RUNTIME_DIR/cclsp-hub/daemon.sock` | Control socket path. |

## Lifecycle

- The daemon **auto-starts** on the first CLI call and runs detached.
- Roots are kept warm and evicted when idle (`CCLSP_HUB_IDLE_ROOT_SEC`) or when
  the LRU cap (`CCLSP_HUB_MAX_ROOTS`) is exceeded.
- Socket and pid live under `$XDG_RUNTIME_DIR` (ephemeral by design — runtime
  state, not persisted).
- `cclsp-hub shutdown` stops everything; `restart-root` recovers a single stale
  index without touching the others.

## Relationship to cclsp

cclsp-hub does not fork or modify cclsp — it spawns the stock `cclsp/dist/index.js`
as child processes and speaks its MCP protocol. Upgrading cclsp (new tools, fixes)
is picked up automatically; new tools appear in `describe` and are callable via
`call <tool>` (and as named subcommands once you add an alias).
