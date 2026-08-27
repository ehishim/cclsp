// RootPool owns the warm cclsp children, one per registered project root. Each
// child is a normal cclsp MCP server spawned over stdio with its cwd set to the
// root, so cclsp's `rootDir: "."` lands the language servers on that project.

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { detectProjectRoot, projectSearchDirectory } from './root-discovery.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  CCLSP_CONFIG_PATH,
  CCLSP_ENTRY,
  CHILD_RUNTIME,
  IDLE_ROOT_MS,
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
  /**
   * This root's language server could not serve a file BELOW it, so it is no
   * longer offered as a covering root for nested paths. It stays usable for its
   * own exact root, which is what its caller actually asked for.
   */
  coverageBroken?: boolean;
}

export interface ToolSchema {
  name: string;
  description?: string;
  inputSchema: any;
}

export interface RoutedRoot {
  entry: RootEntry;
  detectedRoot: string;
  servingRoot: string;
  reused: boolean;
}

interface RootPoolOptions {
  discoverProjectRoot?: (target: string) => string | undefined;
}

interface DiscoveryCacheEntry {
  root: string | null;
  checkedAt: number;
}

const DISCOVERY_CACHE_LIMIT = 4096;
const NEGATIVE_DISCOVERY_TTL_MS = 5_000;

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
  private warming = new Map<string, Promise<{ entry: RootEntry; reused: boolean }>>();
  private detectedRoots = new Map<string, number>();
  private discoveryCache = new Map<string, DiscoveryCacheEntry>();
  private toolSchemas: ToolSchema[] | null = null;
  private readonly discoverProjectRoot: (target: string) => string | undefined;

  constructor(options: RootPoolOptions = {}) {
    this.discoverProjectRoot = options.discoverProjectRoot ?? detectProjectRoot;
  }

  list(): RootEntry[] {
    return [...this.roots.values()].sort((a, b) => a.root.localeCompare(b.root));
  }

  get(rootInput: string): RootEntry | undefined {
    return this.roots.get(normalizeRoot(rootInput));
  }

  private makeChild(
    root: string,
    opts: { preload?: boolean } = {}
  ): { client: Client; transport: StdioClientTransport } {
    const transport = new StdioClientTransport({
      command: CHILD_RUNTIME,
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
  async ensure(
    rootInput: string,
    opts: { isolate?: boolean } = {}
  ): Promise<{ entry: RootEntry; reused: boolean }> {
    const root = normalizeRoot(rootInput);
    this.rememberDetectedRoot(root);
    const existing = this.roots.get(root);
    if (existing) {
      existing.lastUsed = Date.now();
      return { entry: existing, reused: true };
    }
    // Subroot reuse: if an already-warm root encloses this path, its language server
    // already covers these files — reuse it instead of spawning a second one. Pass
    // isolate to force a dedicated instance (e.g. a monorepo package with its own config).
    //
    // "Already covers these files" holds only while that server can actually serve
    // them. A root registered ABOVE a package — which is what an Agent whose cwd is
    // a Worktree top registers by default — may have no toolchain of its own, and
    // handing it out then returns ITS failure for every nested request, for the
    // daemon's lifetime, phrased as a fact about the language rather than about the
    // root that was reused.
    if (!opts.isolate) {
      const covering = this.findCoveringRoot(root);
      if (covering) {
        covering.lastUsed = Date.now();
        return { entry: covering, reused: true };
      }
    }
    const inFlight = this.warming.get(root);
    if (inFlight) {
      const result = await inFlight;
      return { entry: result.entry, reused: true };
    }
    const warming = (async () => {
      const { client, transport } = this.makeChild(root);
      await client.connect(transport);
      // Check after connect: concurrent cold roots resume here serially, so the
      // final pool cannot race above its configured LRU cap.
      if (this.roots.size >= MAX_ROOTS) {
        const lru = [...this.roots.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
        if (lru) await this.stop(lru.root);
      }
      const pid = (transport as any).pid ?? (transport as any)._process?.pid ?? undefined;
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
    })();
    this.warming.set(root, warming);
    try {
      return await warming;
    } finally {
      this.warming.delete(root);
    }
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

  private rememberDetectedRoot(root: string): void {
    const normalized = normalizeRoot(root);
    this.detectedRoots.delete(normalized);
    this.detectedRoots.set(normalized, Date.now());
    while (this.detectedRoots.size > MAX_ROOTS * 4) {
      const oldest = this.detectedRoots.keys().next().value;
      if (oldest === undefined) break;
      this.detectedRoots.delete(oldest);
    }
  }

  private knownRootForTarget(target: string): string | undefined {
    const now = Date.now();
    for (const [root, seenAt] of this.detectedRoots) {
      if (now - seenAt > IDLE_ROOT_MS) this.forgetDetectedRoot(root);
    }
    return [...this.detectedRoots.keys()]
      .filter((root) => isUnder(target, root))
      .sort((left, right) => right.length - left.length)[0];
  }

  private forgetDetectedRoot(root: string): void {
    const normalized = normalizeRoot(root);
    this.detectedRoots.delete(normalized);
    for (const [key, cached] of this.discoveryCache) {
      if (cached.root === normalized) this.discoveryCache.delete(key);
    }
  }

  /**
   * The project root that OWNS `target`, discovered from the filesystem.
   *
   * `routeTarget`'s warm fast-path deliberately answers without this, reporting
   * the covering root as both detected and serving. That is the right trade while
   * the covering root works; it is exactly wrong once it has failed, because the
   * caller then needs the root the target actually belongs to. Discovery is paid
   * only on that failure path.
   */
  owningRoot(target: string): string | undefined {
    return this.discover(resolve(target));
  }

  private discover(target: string): string | undefined {
    const key = projectSearchDirectory(target);
    const cached = this.discoveryCache.get(key);
    if (cached && (cached.root !== null || Date.now() - cached.checkedAt < NEGATIVE_DISCOVERY_TTL_MS)) {
      this.discoveryCache.delete(key);
      this.discoveryCache.set(key, cached);
      return cached.root ?? undefined;
    }
    const root = this.discoverProjectRoot(target);
    this.discoveryCache.set(key, { root: root ?? null, checkedAt: Date.now() });
    while (this.discoveryCache.size > DISCOVERY_CACHE_LIMIT) {
      const oldest = this.discoveryCache.keys().next().value;
      if (oldest === undefined) break;
      this.discoveryCache.delete(oldest);
    }
    return root;
  }

  async routeTarget(target: string): Promise<RoutedRoot> {
    const absoluteTarget = resolve(target);
    const warm = this.resolveRootForFile(absoluteTarget);
    if (warm) {
      warm.lastUsed = Date.now();
      this.rememberDetectedRoot(warm.root);
      return { entry: warm, detectedRoot: warm.root, servingRoot: warm.root, reused: true };
    }

    const knownRoot = this.knownRootForTarget(absoluteTarget);
    if (knownRoot && existsSync(knownRoot)) {
      const { entry, reused } = await this.ensure(knownRoot);
      return { entry, detectedRoot: knownRoot, servingRoot: entry.root, reused };
    }
    if (knownRoot) this.forgetDetectedRoot(knownRoot);

    const detectedRoot = this.discover(absoluteTarget);
    if (!detectedRoot) throw new Error(`no language project owns ${absoluteTarget}`);
    this.rememberDetectedRoot(detectedRoot);
    const { entry, reused } = await this.ensure(detectedRoot);
    return { entry, detectedRoot, servingRoot: entry.root, reused };
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

  /**
   * The most specific warm root that encloses `root` AND can still serve paths
   * below it. A root retired by {@link markCoverageBroken} is skipped here and
   * nowhere else, so it stays usable for its own exact root.
   */
  findCoveringRoot(root: string): RootEntry | undefined {
    const normalized = normalizeRoot(root);
    return this.list()
      .filter((e) => isUnder(normalized, e.root) && !e.coverageBroken)
      .sort((a, b) => b.root.length - a.root.length)[0];
  }

  /** Stop offering `entry` as a covering root for paths below it. */
  markCoverageBroken(entry: RootEntry): void {
    entry.coverageBroken = true;
  }
}
