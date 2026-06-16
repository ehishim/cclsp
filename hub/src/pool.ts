// RootPool owns the warm cclsp children, one per registered project root. Each
// child is a normal cclsp MCP server spawned over stdio with its cwd set to the
// root, so cclsp's `rootDir: "."` lands the language servers on that project.

import { resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CCLSP_CONFIG_PATH,
  CCLSP_ENTRY,
  MAX_ROOTS,
  TOOL_TIMEOUT_MS,
  VERSION,
} from './config.js';

export interface RootEntry {
  root: string;
  client: Client;
  pid: number | undefined;
  startedAt: number;
  lastUsed: number;
}

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema: any;
}

export function normalizeRoot(p: string): string {
  let r = resolve(p);
  if (r.length > 1 && r.endsWith('/')) r = r.slice(0, -1);
  return r;
}

export function isUnder(file: string, root: string): boolean {
  const f = resolve(file);
  return f === root || f.startsWith(`${root}/`);
}

export class RootPool {
  private roots = new Map<string, RootEntry>();
  private toolSchemas: ToolSchema[] | null = null;

  list(): RootEntry[] {
    return [...this.roots.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  get(rootInput: string): RootEntry | undefined {
    return this.roots.get(normalizeRoot(rootInput));
  }

  private makeChild(
    root: string,
    opts: { preload?: boolean } = {},
  ): { client: Client; transport: StdioClientTransport } {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [CCLSP_ENTRY],
      cwd: root,
      // Full env (so PATH resolves the language servers, and cclsp-core vars like
      // CCLSP_MAX_FILES_LIMIT are inherited) plus the cclsp config. Preload warms the
      // language servers eagerly; skip it for throwaway probes (schema-only spawns).
      env: {
        ...(process.env as Record<string, string>),
        CCLSP_CONFIG_PATH,
        ...(opts.preload === false ? {} : { CCLSP_PRELOAD: '1' }),
      },
      stderr: 'ignore',
    });
    const client = new Client({ name: 'cclsp-hub', version: VERSION }, { capabilities: {} });
    return { client, transport };
  }

  // Returns the entry that ended up serving `rootInput` and whether it was reused
  // (an exact match, or an already-warm enclosing root) rather than freshly spawned.
  async ensure(rootInput: string, opts: { isolate?: boolean } = {}): Promise<{ entry: RootEntry; reused: boolean }> {
    const root = normalizeRoot(rootInput);
    const existing = this.roots.get(root);
    if (existing) {
      existing.lastUsed = Date.now();
      return { entry: existing, reused: true };
    }
    // Subroot reuse: if an already-warm root encloses this path, its language server
    // already covers these files — reuse it instead of spawning a second one. Pass
    // isolate to force a dedicated instance (e.g. a monorepo package with its own config).
    if (!opts.isolate) {
      const covering = this.list()
        .filter((e) => isUnder(root, e.root))
        .sort((a, b) => b.root.length - a.root.length)[0];
      if (covering) {
        covering.lastUsed = Date.now();
        return { entry: covering, reused: true };
      }
    }
    // LRU cap: make room before adding a new root.
    if (this.roots.size >= MAX_ROOTS) {
      const lru = [...this.roots.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
      if (lru) await this.stop(lru.root);
    }
    const { client, transport } = this.makeChild(root);
    await client.connect(transport);
    const pid =
      (transport as any).pid ?? (transport as any)._process?.pid ?? undefined;
    const entry: RootEntry = {
      root,
      client,
      pid,
      startedAt: Date.now(),
      lastUsed: Date.now(),
    };
    this.roots.set(root, entry);
    if (!this.toolSchemas) {
      try {
        this.toolSchemas = (await client.listTools()).tools as ToolSchema[];
      } catch {
        // leave null; describe() can fetch it later
      }
    }
    return { entry, reused: false };
  }

  async stop(rootInput: string): Promise<boolean> {
    const root = normalizeRoot(rootInput);
    const entry = this.roots.get(root);
    if (!entry) return false;
    this.roots.delete(root);
    try {
      await entry.client.close();
    } catch {
      // ignore — the child is going away regardless
    }
    return true;
  }

  async restart(rootInput: string): Promise<RootEntry> {
    const root = normalizeRoot(rootInput);
    if (!this.roots.has(root)) {
      throw new Error(`not a registered root: ${root} (see: cclsp-hub list-roots)`);
    }
    await this.stop(root);
    // isolate: respawn this exact root, don't fold it into some enclosing root.
    const { entry } = await this.ensure(root, { isolate: true });
    return entry;
  }

  async stopAll(): Promise<void> {
    await Promise.all(this.list().map((e) => this.stop(e.root)));
  }

  // Longest-prefix match: the most specific registered root that contains `file`.
  resolveRootForFile(file: string): RootEntry | undefined {
    return this.list()
      .filter((e) => isUnder(file, e.root))
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  // The cclsp tool list is static (returned before any language server starts),
  // so a cached copy from any child is authoritative. If no child has ever run,
  // spawn a throwaway probe just to read it.
  async describe(): Promise<ToolSchema[]> {
    if (this.toolSchemas) return this.toolSchemas;
    const probeRoot = normalizeRoot(process.env.CCLSP_HUB_PROBE_ROOT || process.cwd());
    const { client, transport } = this.makeChild(probeRoot, { preload: false });
    try {
      await client.connect(transport);
      this.toolSchemas = (await client.listTools()).tools as ToolSchema[];
      return this.toolSchemas;
    } finally {
      try {
        await client.close();
      } catch {
        // ignore
      }
    }
  }

  async callTool(entry: RootEntry, name: string, args: Record<string, unknown>): Promise<any> {
    entry.lastUsed = Date.now();
    return entry.client.callTool({ name, arguments: args }, undefined, {
      timeout: TOOL_TIMEOUT_MS,
    });
  }
}
