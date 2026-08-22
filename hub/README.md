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
bun install            # if you haven't already (installs the SDK)
cd hub
bun run setup          # build + install the `cclsp-hub` wrapper on PATH
```

`setup` builds both core `../dist/index.js` and hub `dist/index.js`, then installs a
wrapper to `~/.local/bin/cclsp-hub` (override the directory with
`CCLSP_HUB_BIN_DIR`). The wrapper defaults `CCLSP_HUB_ENTRY` to the sibling core
build from the same checkout, so a hub install cannot silently keep spawning an
older core; an explicit runtime `CCLSP_HUB_ENTRY` still overrides it. The pieces
are also available separately. `hub/scripts/ast-installed-smoke.sh` builds and installs a temporary wrapper, exercises every bundled AST grammar plus fallback, bounds, errors, invalidation, and root restart on an isolated daemon/root, then tears everything down.

```bash
bun run build          # → hub/dist/index.js
bun run install-bin    # install the PATH wrapper (needs dist/ built)
bun run uninstall-bin  # remove the wrapper
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
| `ensure-root <path>` | Register a project root and warm its language servers (idempotent). A subroot of an already-warm root is reused — pass `--isolate` to force a dedicated instance. |
| `list-roots` / `roots` | Show active roots with pid, age, idle time. |
| `stop-root <path>` | Tear down one root and its language servers. |
| `restart-root <path>` | Restart one root (recover a stale index). |
| `status` | Daemon status (pid, socket, uptime, roots). Does **not** start the daemon. |
| `shutdown` | Stop all roots and the daemon. |
| `describe` | List the available cclsp tools (and schemas with `--json`). |

### Code intelligence

Every cclsp tool is exposed **1:1 by its exact name**. Routed to the registered
root that owns `--file`. Line/character are **1-indexed**.

| Tool (exact) | Alias | Required | Optional |
|---|---|---|---|
| `ast_search` | `ast-search` | `--pattern --language` | `--path --max-results --root` |
| `find_definition` | `definition` | `--file --symbol-name` | `--symbol-kind` |
| `find_references` | `references` | `--file --symbol-name` | `--symbol-kind --include-declaration` |
| `find_implementation` | `implementation` | `--file --line --character` | |
| `get_hover` | `hover` | `--file --line --character` | |
| `get_document_symbols` | `document-symbols` | `--file` | |
| `get_completions` | `completions` | `--file --line --character` | `--trigger-character --limit` |
| `get_signature_help` | `signatures` | `--file --line --character` | `--trigger-character` |
| `get_code_actions` | `code-actions` | `--file --start-line --start-character --end-line --end-character` | `--title --apply` |
| `get_diagnostics` | `diagnostics` | `--file` | |
| `get_diagnostics_batch` | `diagnostics-batch` | `--path` | `--pattern --max-files` |
| `rename_symbol` | `rename` | `--file --symbol-name --new-name` | `--symbol-kind --dry-run` |
| `rename_symbol_strict` | `rename-strict` | `--file --line --character --new-name` | `--dry-run` |
| `rename_file` | `rename-file` | `--old-path --new-path` | `--dry-run=false` to apply |
| `find_workspace_symbols` | `symbols` | `--query --root` | |
| `prepare_call_hierarchy` | `call-hierarchy` | `--file --line --character` | |
| `get_incoming_calls` | `incoming-calls` | `--file --line --character` | |
| `get_outgoing_calls` | `outgoing-calls` | `--file --line --character` | |
| `restart_server` | `restart-server` | `--root` | `--extensions ts,tsx` |
| `call <tool>` | — | — | `--params-json '{...}'` (raw passthrough) |

Use the exact name, the short alias, or kebab-case (`find-definition`) — all three
work. New cclsp tools are callable by their exact name immediately, no hub release.
Run `cclsp-hub describe` to list whatever the connected cclsp exposes.

### Structural AST search

`ast_search` parses source with installed Tree-sitter/WASM grammars; it does not require a language server. Supported `--language` values are `typescript`, `tsx`, `javascript`, `jsx`, `python`, `php`, `go`, `rust`, and `java`.

```bash
cclsp-hub ast_search --root /workspace/app \
  --language typescript --path src \
  --pattern 'function $NAME($$$ARGS) { $$$BODY }' --max-results 25
```

`$NAME` captures one named syntax node and `$$$NAME` captures zero or more named siblings. The default result limit is 100 and the ceiling is 1,000. Search stays inside the registered root, indexes at most 5,000 deterministically ordered files, skips files larger than 512 KiB during directory searches, and reports typed errors for invalid patterns, unsupported languages, escaped paths, explicit oversized files, and parse failures.

Results carry `provider: "tree-sitter"`, zero-indexed structured ranges, capture ranges, and truncation/index metadata. Tree-sitter fallback for definitions, document symbols, and query-position resolution is explicitly syntax-only; it does not provide semantic references, inferred types, signatures, implementations, call hierarchy, diagnostics, or rename safety. A supported empty LSP answer remains an LSP answer and never falls back.

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
with `ensure-root`. Registration starts language-server indexing in the background;
confirm a known symbol resolves before treating an empty result as evidence of
absence. If a file isn't under any active root, the call fails with a
message telling you which root to add — nothing is auto-spawned:

```
$ cclsp-hub definition --file /workspace/other/x.ts --symbol-name foo
no registered root owns /workspace/other/x.ts
  run: cclsp-hub ensure-root /workspace/other   (detected project root)
  active roots: /workspace/app
```

The hint walks up from the file to suggest the actual project root (nearest
`tsconfig.json`/`package.json`/`composer.json`/`go.mod`, else the git repo).

When several roots match (nested roots), the **longest prefix** wins. Root-less
tools (`symbols`, `restart-server`) require `--root` unless exactly one root is
active.

**Subroot reuse:** registering a path that sits inside an already-warm root returns
that root instead of spawning a second language server — one server covers the whole
tree, which is both faster and usually what you want (the enclosing `tsconfig`
governs the subdir). Use `--isolate` when a nested package needs its own instance.

## Output

- Default: cclsp's human-readable text.
- `--json`: the full MCP `CallToolResult` (`content`, `structuredContent`,
  `isError`, …). A tool error prints to stderr and exits non-zero.
- A capability-backed method the selected language server does not declare returns
  `structuredContent.outcome = "unsupported"`, code
  `LSP_METHOD_UNSUPPORTED`, plus `method` and `server`. This is different from a
  supported empty result, which remains exit 0.
- Rename validation failures return `outcome = "rejected"` and preserve the
  language server's reason; no rename request or file edit follows a rejection.
- AST rejections return `structuredContent.outcome = "rejected"`, a typed
  `AST_*` code, and exit non-zero. A valid empty AST search is `outcome = "ok"`,
  `provider = "tree-sitter"`, `matches = []`, and exit 0.

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

### Inherited cclsp-core vars

`diagnostics-batch` file limits are **not** hub vars — they belong to cclsp core
and reach the children through the inherited environment, so plain cclsp and the
hub honor the same values:

| Var | Default | Purpose |
|---|---|---|
| `CCLSP_MAX_FILES_DEFAULT` | `50` | Files scanned by `diagnostics-batch` when `--max-files` is omitted. |
| `CCLSP_MAX_FILES_LIMIT` | `200` | Upper bound for `diagnostics-batch` (raise to scan more at once). |

## Updating after a source change

The CLI runs as a fresh process on every call, so CLI-only edits take effect on the
next invocation. The **daemon is long-lived** and keeps the previously built bundle
in memory, so daemon-side edits (`daemon.ts`, `pool.ts`, `protocol.ts`, `config.ts`)
need a rebuild **and** a daemon restart:

```bash
cd /workspace/cclsp/hub
bun run reload     # rebuild dist/, then shut the daemon down
                   # (the next cclsp-hub call auto-starts the new build)
```

`reload` = `bun run build` + `cclsp-hub shutdown`. The wrapper path is unchanged, so
you don't reinstall it; run `bun run setup` again only if you moved the dist path.
Note that restarting the daemon drops the warm roots — they re-index on next use.

Rebuilt **cclsp itself** (the parent `dist/index.js`)? The hub's warm children are
still running the old cclsp; refresh them with `cclsp-hub restart-root <path>` (one
root) or `cclsp-hub shutdown` (all). To bump the reported `--version`, edit
`version` in `package.json` and `VERSION` in `src/config.ts`, then rebuild.

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
