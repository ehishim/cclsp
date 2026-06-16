// cclsp-hub CLI: parses argv, talks to the daemon, and formats output. Tool
// subcommands are friendly aliases over cclsp's MCP tools; flags map to tool
// parameters (kebab-case accepted, --file is sugar for --file_path).

import { VERSION } from './config.js';
import { request, tryRequest } from './client.js';
import type { ToolSchema } from './pool.js';

// Friendly subcommand -> cclsp tool name.
const ALIASES: Record<string, string> = {
  definition: 'find_definition',
  references: 'find_references',
  implementation: 'find_implementation',
  rename: 'rename_symbol',
  'rename-strict': 'rename_symbol_strict',
  diagnostics: 'get_diagnostics',
  'diagnostics-batch': 'get_diagnostics_batch',
  hover: 'get_hover',
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
const KNOWN_BOOLEAN = new Set(['json', 'help', 'version', 'dry-run', 'include-declaration']);

interface Parsed {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parse(argv: string[]): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
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
        flags.set(body.slice(0, eq), body.slice(eq + 1));
      } else if (KNOWN_BOOLEAN.has(body)) {
        flags.set(body, true);
      } else {
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(body, next);
          i++;
        } else {
          flags.set(body, true);
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

function printToolResult(result: any, json: boolean): void {
  if (json) {
    out(asJson(result));
  } else {
    const text = Array.isArray(result?.content)
      ? result.content.map((c: any) => (c?.type === 'text' ? c.text : asJson(c))).join('\n')
      : asJson(result);
    if (result?.isError) err(text);
    else out(text);
  }
  if (result?.isError) process.exitCode = 1;
}

function rootArg(p: Parsed): string | undefined {
  const flag = p.flags.get('root');
  if (typeof flag === 'string') return flag;
  return p.positionals[0];
}

const TOP_HELP = `cclsp-hub ${VERSION} — multi-root daemon + CLI over the cclsp language-server MCP

One warm cclsp instance (and its language servers) is kept per project ROOT and
shared by every caller. Code-intelligence calls route to the root that owns the
target file. Routing is explicit: the root must be registered first.

USAGE
  cclsp-hub <command> [options]

ROOTS & DAEMON
  ensure-root <path>      Register a project root and warm its language servers
  list-roots | roots      Show active roots (pid, age, idle)
  stop-root <path>        Tear down one root
  restart-root <path>     Restart one root (recover a stale index)
  status                  Daemon status (pid, socket, uptime, roots)
  shutdown                Stop all roots and the daemon
  describe                List the available cclsp tools

CODE INTELLIGENCE  (routed by --file; symbols needs --root)
  definition        --file F --symbol-name NAME [--symbol-kind K]
  references        --file F --symbol-name NAME [--symbol-kind K]
  implementation    --file F --line N --character C
  hover             --file F --line N --character C
  diagnostics       --file F
  diagnostics-batch --path P [--pattern RE] [--max-files N]
  rename            --file F --symbol-name NAME --new-name NEW [--dry-run]
  rename-strict     --file F --line N --character C --new-name NEW [--dry-run]
  symbols           --query Q --root R
  call-hierarchy    --file F --line N --character C
  incoming-calls    --file F --line N --character C
  outgoing-calls    --file F --line N --character C
  restart-server    --root R [--extensions ts,tsx]
  call <tool>       Raw passthrough; combine with --params-json '{...}'

OPTIONS
  --root <path>     Force which registered root serves the call
  --json            Machine-readable JSON output
  -h, --help        This help (or '<command> --help' for a command's parameters)
  --version         Print version

LINE/CHARACTER are 1-indexed. Run 'cclsp-hub <command> --help' for parameters.

TIP  Prefer a root at the PROJECT ROOT — the directory with tsconfig.json /
     package.json (TS/JS) or composer.json (PHP). Pointing at a random subdir makes
     the language server fall back to an inferred project (missed cross-file refs,
     no path-alias resolution). Register the repo root; query files anywhere under it.

ENV
  CCLSP_HUB_ENTRY            cclsp dist/index.js to spawn (default /workspace/cclsp/dist/index.js)
  CCLSP_HUB_CONFIG           cclsp server config (default ~/.config/claude/cclsp.json)
  CCLSP_HUB_MAX_ROOTS        max concurrent roots (default 30, LRU-evicted)
  CCLSP_HUB_IDLE_ROOT_SEC    evict a root after this idle time (default 1800)
  CCLSP_HUB_TOOL_TIMEOUT_SEC per-call timeout (default 180)
  CCLSP_HUB_SOCKET           override the control socket path`;

async function printToolHelp(command: string, toolName: string): Promise<void> {
  const { tools } = (await request('describe')) as { tools: ToolSchema[] };
  const schema = tools.find((t) => t.name === toolName);
  if (!schema) {
    err(`unknown tool: ${toolName}`);
    process.exitCode = 1;
    return;
  }
  const props: Record<string, any> = schema.inputSchema?.properties ?? {};
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
  out('\nThe call routes to the registered root that owns --file (or pass --root).');
}

function printManagementHelp(command: string): void {
  const help: Record<string, string> = {
    'ensure-root':
      'cclsp-hub ensure-root <path>\n' +
      '  Register a project root and warm its language servers (idempotent).\n\n' +
      '  Prefer the PROJECT ROOT — the directory containing tsconfig.json / package.json\n' +
      '  (TS/JS) or composer.json (PHP). A random subdir makes the language server fall\n' +
      '  back to an inferred project (missed cross-file refs, no path-alias resolution).\n' +
      '  Register the repo root, then query files anywhere under it.',
    'stop-root': 'cclsp-hub stop-root <path>\n  Tear down one root and its language servers.',
    'restart-root': 'cclsp-hub restart-root <path>\n  Restart one root (recover a stale index).',
    'list-roots': 'cclsp-hub list-roots [--json]\n  Show active roots with pid, age, and idle time.',
    roots: 'cclsp-hub roots [--json]\n  Alias for list-roots.',
    status: 'cclsp-hub status [--json]\n  Show daemon status (does not start the daemon).',
    shutdown: 'cclsp-hub shutdown\n  Stop all roots and the daemon.',
    describe: 'cclsp-hub describe [--json]\n  List the available cclsp tools.',
  };
  out(help[command] ?? TOP_HELP);
}

export async function runCli(argv: string[]): Promise<void> {
  const p = parse(argv);
  const json = p.flags.get('json') === true;
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
        const res: any = await tryRequest('status');
        if (!res) {
          out(json ? asJson({ running: false }) : 'daemon: not running');
          return;
        }
        if (json) return out(asJson(res));
        out(`daemon: running (pid ${res.pid})`);
        out(`socket: ${res.socket}`);
        out(`uptime: ${res.uptimeSec}s`);
        out(`roots:  ${res.roots.length}`);
        for (const r of res.roots) out(`  - ${r}`);
        return;
      }
      case 'ensure-root': {
        const root = rootArg(p);
        if (!root) {
          err('usage: cclsp-hub ensure-root <path>');
          process.exitCode = 1;
          return;
        }
        const res: any = await request('ensure-root', { root });
        out(json ? asJson(res) : `warmed root: ${res.root} (pid ${res.pid ?? '?'}) — language servers indexing in background`);
        return;
      }
      case 'list-roots':
      case 'roots': {
        const res: any = await tryRequest('list-roots');
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
        const res: any = await tryRequest('stop-root', { root });
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
        const res: any = await request('restart-root', { root });
        out(json ? asJson(res) : `restarted: ${res.root} (pid ${res.pid ?? '?'})`);
        return;
      }
      case 'shutdown': {
        const res: any = await tryRequest('shutdown');
        out(res ? 'daemon stopped' : 'daemon not running');
        return;
      }
      case 'describe': {
        const res: any = await request('describe');
        if (json) return out(asJson(res));
        for (const t of res.tools as ToolSchema[]) out(`${t.name}  —  ${t.description ?? ''}`);
        return;
      }
    }
  }

  // ---- tool commands ----
  const toolName =
    p.command === 'call' ? String(p.positionals[0] ?? '') : (ALIASES[p.command] ?? p.command);
  if (!toolName) {
    err('usage: cclsp-hub call <tool> [--params-json \'{...}\']');
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
    if (['json', 'help', 'version', 'root', 'params-json'].includes(k)) continue;
    const key = FLAG_ALIASES[k] ?? k.replace(/-/g, '_');
    params[key] = v;
  }
  const pj = p.flags.get('params-json');
  if (typeof pj === 'string') Object.assign(params, JSON.parse(pj));

  const result = await request('tool', {
    name: toolName,
    params,
    root: typeof p.flags.get('root') === 'string' ? p.flags.get('root') : undefined,
  });
  printToolResult(result, json);
}
