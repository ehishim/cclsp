// cclsp-hub CLI: parses argv, talks to the daemon, and formats output. Tool
// subcommands are friendly aliases over cclsp's MCP tools; flags map to tool
// parameters (kebab-case accepted, --file is sugar for --file_path).

import { request, tryRequest } from './client.js';
import { CCLSP_ENTRY, VERSION } from './config.js';
import type { ToolSchema } from './pool.js';
import { toolResultText } from './tool-result.js';
export { normalizeToolResult as normalizeToolJson } from './tool-result.js';

// Friendly subcommand -> cclsp tool name.
const ALIASES: Record<string, string> = {
  'ast-search': 'ast_search',
  'code-rewrite': 'code_rewrite',
  definition: 'find_definition',
  references: 'find_references',
  implementation: 'find_implementation',
  rename: 'rename_symbol',
  'rename-strict': 'rename_symbol_strict',
  diagnostics: 'get_diagnostics',
  'diagnostics-batch': 'get_diagnostics_batch',
  hover: 'get_hover',
  'document-symbols': 'get_document_symbols',
  completions: 'get_completions',
  signatures: 'get_signature_help',
  'code-actions': 'get_code_actions',
  'rename-file': 'rename_file',
  symbols: 'find_workspace_symbols',
  'call-hierarchy': 'prepare_call_hierarchy',
  'incoming-calls': 'get_incoming_calls',
  'outgoing-calls': 'get_outgoing_calls',
  'restart-server': 'restart_server',
};

const MANAGEMENT = new Set([
  'status',
  'ensure-root',
  'list-roots',
  'roots',
  'stop-root',
  'restart-root',
  'shutdown',
  'describe',
]);

// Flag-name sugar -> canonical cclsp parameter.
const FLAG_ALIASES: Record<string, string> = {
  file: 'file_path',
  symbol: 'symbol_name',
};

// Flags that are always boolean — they must never consume the following token
// (e.g. `--json diagnostics` is the json flag + the diagnostics command).
// Repeating one of these accumulates instead of overwriting. Deliberately not a
// comma split: a structural pattern legitimately contains commas (`f($A, $B)`),
// so splitting on them would silently corrupt the pattern it claims to accept.
const KNOWN_MULTI = new Set(['pattern', 'path']);

const KNOWN_BOOLEAN = new Set([
  'json',
  'raw-mcp',
  'help',
  'version',
  'dry-run',
  'apply',
  'include-declaration',
  'synthetic-trigger',
  'isolate',
]);

interface Parsed {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean | string[]>;
}

interface RootSummary {
  root: string;
  pid?: number;
  ageSec: number;
  idleSec: number;
}

export function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean | string[]>();
  const setFlag = (key: string, value: string | boolean): void => {
    const existing = flags.get(key);
    if (existing === undefined || !KNOWN_MULTI.has(key)) {
      flags.set(key, value);
      return;
    }
    flags.set(
      key,
      Array.isArray(existing) ? [...existing, String(value)] : [String(existing), String(value)]
    );
  };
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === undefined) continue;
    if (a === '-h' || a === '--help') {
      flags.set('help', true);
    } else if (a === '--version') {
      flags.set('version', true);
    } else if (a.startsWith('--')) {
      const body = a.slice(2);
      const eq = body.indexOf('=');
      if (eq !== -1) {
        setFlag(body.slice(0, eq), body.slice(eq + 1));
      } else if (KNOWN_BOOLEAN.has(body)) {
        setFlag(body, true);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          setFlag(body, next);
          i++;
        } else {
          setFlag(body, true);
        }
      }
    } else if (command === undefined) {
      command = a;
    } else {
      positionals.push(a);
    }
  }
  return { command, positionals, flags };
}

function out(s: string): void {
  process.stdout.write(`${s}\n`);
}
function err(s: string): void {
  process.stderr.write(`${s}\n`);
}
function asJson(v: unknown): string {
  return JSON.stringify(v, null, 2);
}

function printToolResult(result: unknown, json: boolean): void {
  const isError = Boolean(
    result && typeof result === 'object' && (result as { isError?: unknown }).isError === true
  );
  const text = toolResultText(result) || asJson(result);
  if (json) out(asJson(result));
  else if (isError) err(text);
  else out(text);
  if (isError) process.exitCode = 1;
}

function rootArg(p: Parsed): string | undefined {
  const flag = p.flags.get('root');
  if (typeof flag === 'string') return flag;
  return p.positionals[0];
}

const TOP_HELP = `cclsp-hub ${VERSION} — multi-root daemon + CLI over the cclsp language-server MCP

One warm cclsp instance (and its language servers) is kept per project ROOT and
shared by every caller. Target-bearing calls discover the owning language project
before warm reuse, so a warm parent never overrides a nested project's semantics.

USAGE
  cclsp-hub <command> [options]

ROOTS & DAEMON
  ensure-root <path>      Register a project root and warm its language servers
                          (a subroot of a warm root is reused; --isolate to force new)
  list-roots | roots      Show active roots (pid, age, idle)
  stop-root <path>        Tear down one root
  restart-root <path>     Restart warm roots serving this path (including covering roots)
  status                  Daemon status (pid, socket, uptime, in-flight tools, roots)
  shutdown                Stop all roots and the daemon
  describe                List the available cclsp tools

CODE INTELLIGENCE  (cclsp tools 1:1; routed by target path, otherwise caller cwd)
  ast_search              --pattern P [--pattern P2 ...] --language L [--path P]
                          [--max-results N] [--root R]   (repeat --pattern: exact counts require a complete scan)
  code_rewrite            --pattern P --replacement R --language L [--path P] [--root R]
                          [--dry-run=false --candidate-id ID]
  find_definition         --file F (--symbol-name NAME [--symbol-kind K] | --line N --character C)
  find_references         --file F (--symbol-name NAME [--symbol-kind K] | --line N --character C) [--include-declaration]
  find_implementation     --file F (--query Q | --line N --character C)
  get_hover               --file F (--query Q | --line N --character C)
  get_document_symbols    --file F
  get_completions         --file F (--query Q | --line N --character C) [--limit N]
                          [--resolve-limit N] [--synthetic-trigger]
  get_signature_help      --file F (--query Q | --line N --character C)
  get_code_actions        --file F (--query Q | --start-line N --start-character N
                          --end-line N --end-character N) [--limit N] [--title T] [--apply]
  get_diagnostics         --file F
  get_diagnostics_batch   --path P [--path P2 ...] [--pattern RE] [--max-files N]
  rename_symbol           --file F --symbol-name NAME --new-name NEW [--dry-run]
  rename_symbol_strict    --file F (--query Q | --line N --character C) --new-name NEW [--dry-run]
  rename_file             --old-path F --new-path F [--dry-run=false]
  find_workspace_symbols  --query Q [--root R]
  prepare_call_hierarchy  --file F (--query Q | --line N --character C)
  get_incoming_calls      --file F (--query Q | --line N --character C)
  get_outgoing_calls      --file F (--query Q | --line N --character C)
  restart_server          --root R [--extensions ts,tsx]
  call <tool>             Raw passthrough; combine with --params-json '{...}'

For two or more diagnostic scopes, repeat --path in one call; cclsp collapses the values,
deduplicates files and reconciles each language provider once.

Structural rewrite is syntax-only and defaults to preview. Inspect its candidate ID before
explicit apply; use rename_symbol_strict for semantic symbol renames.

Short aliases (and kebab-case) also work: ast-search, code-rewrite, definition, references, implementation,
hover, document-symbols, completions, signatures, code-actions, rename-file,
diagnostics, diagnostics-batch, rename, rename-strict, symbols, call-hierarchy,
incoming-calls, outgoing-calls, restart-server.

OPTIONS
  --root <path>     Override auto-routing; ensure/reuse this project root
  --json            Normalized machine output (transport envelope removed)
  --raw-mcp         Diagnostic raw MCP envelope (implies --json)
  -h, --help        This help (or '<command> --help' for a command's parameters)
  --version         Print version

POSITION TOOLS accept exactly one selector: --query Q or a complete 1-indexed
line/character pair. Ambiguous and unknown queries return bounded candidates.
A workspace-index query waits for provider readiness; an unconfirmed timeout is
typed stale instead of false absence. Run '<command> --help' for parameters.

TIP  Prefer a root at the PROJECT ROOT — the directory with tsconfig.json /
     package.json (TS/JS) or composer.json (PHP). Pointing at a random subdir makes
     the language server fall back to an inferred project (missed cross-file refs,
     no path-alias resolution). Register the repo root; query files anywhere under it.

ENV
  CCLSP_HUB_ENTRY            cclsp dist/index.js to spawn (effective: ${CCLSP_ENTRY})
  CCLSP_HUB_CONFIG           cclsp server config (default ~/.config/claude/cclsp.json)
  CCLSP_HUB_MAX_ROOTS        max concurrent roots (default 30, LRU-evicted)
  CCLSP_HUB_IDLE_ROOT_SEC    evict a root after this idle time (default 1800)
  CCLSP_HUB_TOOL_TIMEOUT_SEC per-call timeout (default 180)
  CCLSP_HUB_SOCKET           override the control socket path

Inherited by the cclsp children (set in the daemon's environment):
  CCLSP_MAX_FILES_DEFAULT    files scanned by diagnostics-batch when --max-files omitted (50)
  CCLSP_MAX_FILES_LIMIT      upper bound for diagnostics-batch (200)`;

async function printToolHelp(command: string, toolName: string): Promise<void> {
  const { tools } = (await request('describe')) as { tools: ToolSchema[] };
  const schema = tools.find((t) => t.name === toolName);
  if (!schema) {
    err(`unknown tool: ${toolName}`);
    process.exitCode = 1;
    return;
  }
  const props = (schema.inputSchema?.properties ?? {}) as Record<
    string,
    { type?: string; description?: string }
  >;
  const required: string[] = schema.inputSchema?.required ?? [];
  out(`cclsp-hub ${command} — ${schema.description ?? toolName}`);
  out('');
  out('PARAMETERS');
  for (const [name, spec] of Object.entries(props)) {
    const flag = `--${name.replace(/_/g, '-')}`;
    const req = required.includes(name) ? ' (required)' : '';
    const type = spec?.type ? ` <${spec.type}>` : '';
    const desc = spec?.description ? `  ${spec.description}` : '';
    out(`  ${flag}${type}${req}${desc}`);
  }
  if (props.file_path) out('\n  --file is accepted as an alias for --file-path');
  out('\nTarget paths auto-route through warm coverage and project discovery; --root overrides.');
}

function printManagementHelp(command: string): void {
  const help: Record<string, string> = {
    'ensure-root':
      'cclsp-hub ensure-root <path> [--isolate]\n' +
      '  Explicitly warm a project root. Normal target-bearing calls discover the\n' +
      '  owning language project, then reuse or ensure that exact root.\n' +
      '  A covered subroot reuses its enclosing instance; pass --isolate only to force\n' +
      '  a dedicated instance.',
    'stop-root': 'cclsp-hub stop-root <path>\n  Tear down one root and its language servers.',
    'restart-root':
      'cclsp-hub restart-root <path>\n  Restart warm roots at/below this path and its serving covering root. No warm root is a typed refusal; none is created merely to restart.',
    'list-roots':
      'cclsp-hub list-roots [--json]\n  Show active roots with pid, age, and idle time.',
    roots: 'cclsp-hub roots [--json]\n  Alias for list-roots.',
    status:
      'cclsp-hub status [--json]\n  Show daemon status, roots, and in-flight tool requests (does not start the daemon).',
    shutdown: 'cclsp-hub shutdown\n  Stop all roots and the daemon.',
    describe: 'cclsp-hub describe [--json]\n  List the available cclsp tools.',
  };
  out(help[command] ?? TOP_HELP);
}

export async function runCli(argv: string[]): Promise<void> {
  const p = parse(argv);
  const rawMcp = p.flags.get('raw-mcp') === true;
  const json = rawMcp || p.flags.get('json') === true;
  const wantHelp = p.flags.get('help') === true;

  if (p.flags.get('version') === true) {
    out(`cclsp-hub ${VERSION}`);
    return;
  }
  if (p.command === undefined || p.command === 'help') {
    out(TOP_HELP);
    return;
  }

  // ---- management commands ----
  if (MANAGEMENT.has(p.command)) {
    if (wantHelp) {
      printManagementHelp(p.command);
      return;
    }
    switch (p.command) {
      case 'status': {
        const res = (await tryRequest('status')) as {
          pid: number;
          socket: string;
          uptimeSec: number;
          inFlightRequests?: number;
          roots: string[];
        } | null;
        if (!res) {
          out(json ? asJson({ running: false }) : 'daemon: not running');
          return;
        }
        if (json) return out(asJson(res));
        out(`daemon: running (pid ${res.pid})`);
        out(`socket: ${res.socket}`);
        out(`uptime: ${res.uptimeSec}s`);
        out(`in-flight tool requests: ${res.inFlightRequests ?? 'unknown'}`);
        out(`roots:  ${res.roots.length}`);
        for (const r of res.roots) out(`  - ${r}`);
        return;
      }
      case 'ensure-root': {
        const root = rootArg(p);
        if (!root) {
          err('usage: cclsp-hub ensure-root <path> [--isolate]');
          process.exitCode = 1;
          return;
        }
        const res = (await request('ensure-root', {
          root,
          isolate: p.flags.get('isolate') === true,
        })) as { reused: boolean; root: string; requested: string; pid?: number };
        if (json) {
          out(asJson(res));
        } else if (res.reused && res.root !== res.requested) {
          out(
            `covered by existing root: ${res.root} (serves ${res.requested}) — no new server spawned`
          );
        } else if (res.reused) {
          out(`root already warm: ${res.root}`);
        } else {
          out(
            `warmed root: ${res.root} (pid ${res.pid ?? '?'}) — language servers indexing in background`
          );
        }
        return;
      }
      case 'list-roots':
      case 'roots': {
        const res = (await tryRequest('list-roots')) as { roots: RootSummary[] } | null;
        if (!res) {
          out(json ? asJson({ roots: [] }) : 'no active roots (daemon not running)');
          return;
        }
        if (json) return out(asJson(res));
        if (res.roots.length === 0) return out('no active roots');
        for (const r of res.roots) {
          out(`${r.root}`);
          out(`    pid ${r.pid ?? '?'} · age ${r.ageSec}s · idle ${r.idleSec}s`);
        }
        return;
      }
      case 'stop-root': {
        const root = rootArg(p);
        if (!root) {
          err('usage: cclsp-hub stop-root <path>');
          process.exitCode = 1;
          return;
        }
        const res = (await tryRequest('stop-root', { root })) as { stopped: boolean } | null;
        if (!res) return out('daemon not running; nothing to stop');
        out(json ? asJson(res) : res.stopped ? `stopped: ${root}` : `not registered: ${root}`);
        return;
      }
      case 'restart-root': {
        const root = rootArg(p);
        if (!root) {
          err('usage: cclsp-hub restart-root <path>');
          process.exitCode = 1;
          return;
        }
        const res = (await request('restart-root', { root })) as {
          root: string;
          pid?: number;
          roots?: Array<{ root: string; pid?: number }>;
        };
        out(
          json
            ? asJson(res)
            : (res.roots ?? [res])
                .map((entry) => `restarted: ${entry.root} (pid ${entry.pid ?? '?'})`)
                .join('\n')
        );
        return;
      }
      case 'shutdown': {
        const res = await tryRequest('shutdown');
        out(res ? 'daemon stopped' : 'daemon not running');
        return;
      }
      case 'describe': {
        const res = (await request('describe')) as { tools: ToolSchema[] };
        if (json) return out(asJson(res));
        for (const t of res.tools as ToolSchema[]) out(`${t.name}  —  ${t.description ?? ''}`);
        return;
      }
    }
  }

  // ---- tool commands ----
  // Every cclsp tool is callable 1:1 by its exact name (find_definition, …). The
  // short aliases (definition, …) are conveniences, and kebab is accepted too
  // (find-definition → find_definition). `call <tool>` is the raw escape hatch.
  const rawCmd = p.command;
  const toolName =
    rawCmd === 'call'
      ? String(p.positionals[0] ?? '')
      : (ALIASES[rawCmd] ?? rawCmd.replace(/-/g, '_'));
  if (!toolName) {
    err("usage: cclsp-hub call <tool> [--params-json '{...}']");
    process.exitCode = 1;
    return;
  }
  if (wantHelp) {
    await printToolHelp(p.command, toolName);
    return;
  }

  // Collect parameters from flags (kebab -> snake, plus --file/--symbol sugar).
  const params: Record<string, unknown> = {};
  for (const [k, v] of p.flags) {
    if (['json', 'raw-mcp', 'help', 'version', 'root', 'params-json'].includes(k)) continue;
    const key = FLAG_ALIASES[k] ?? k.replace(/-/g, '_');
    params[key] =
      KNOWN_BOOLEAN.has(k) && typeof v === 'string' && (v === 'true' || v === 'false')
        ? v === 'true'
        : v;
  }
  const pj = p.flags.get('params-json');
  if (typeof pj === 'string') Object.assign(params, JSON.parse(pj));

  const result = await request('tool', {
    name: toolName,
    params,
    root: typeof p.flags.get('root') === 'string' ? p.flags.get('root') : undefined,
    cwd: process.cwd(),
    rawMcp,
  });
  printToolResult(result, json);
}
