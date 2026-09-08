// RootPool routing tests prove owner-first selection and bounded discovery-cache behavior.

import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IDLE_ROOT_MS, TOOL_TIMEOUT_MS } from './config.js';
import { type RootEntry, RootPool, normalizeRoot } from './pool.js';

const fixtures: string[] = [];
afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cclsp-pool-routing-'));
  fixtures.push(root);
  return root;
}

function entry(root: string): RootEntry {
  return {
    root: normalizeRoot(root),
    client: {} as RootEntry['client'],
    pid: undefined,
    startedAt: Date.now(),
    lastUsed: Date.now(),
  };
}

function seedWarm(pool: RootPool, root: string): RootEntry {
  const warm = entry(root);
  (pool as unknown as { roots: Map<string, RootEntry> }).roots.set(warm.root, warm);
  return warm;
}

describe('RootPool smart target routing', () => {
  it('finds descendant and covering serving roots without starting a core', () => {
    const pool = new RootPool();
    const root = fixture();
    const nested = join(root, 'package');
    mkdirSync(nested);
    const outer = seedWarm(pool, root);
    const inner = seedWarm(pool, nested);
    expect(pool.servingRoots(root)).toEqual([outer, inner]);
    expect(pool.servingRoots(join(nested, 'src'))).toEqual([inner]);
    expect(pool.servingRoots(fixture())).toEqual([]);
    expect(pool.list()).toHaveLength(2);
  });
  it('uses the most-specific warm root after confirming its detected owner', async () => {
    const outer = fixture();
    const nested = join(outer, 'packages/app');
    const discover = mock(() => nested);
    const pool = new RootPool({ discoverProjectRoot: discover });
    mkdirSync(join(nested, 'src'), { recursive: true });
    seedWarm(pool, outer);
    const expected = seedWarm(pool, nested);
    const ensure = mock(pool.ensure.bind(pool));
    pool.ensure = ensure;

    const routed = await pool.routeTarget(join(nested, 'src/index.ts'));

    expect(routed).toMatchObject({ entry: expected, detectedRoot: nested, servingRoot: nested, reused: true });
    expect(discover).toHaveBeenCalledTimes(1);
    expect(ensure).not.toHaveBeenCalled();
  });

  it('does not let a warm covering root override a nested detected project', async () => {
    const outer = fixture();
    const nested = join(outer, 'packages/app');
    mkdirSync(join(nested, 'src'), { recursive: true });
    const discover = mock(() => nested);
    const pool = new RootPool({ discoverProjectRoot: discover });
    seedWarm(pool, outer);
    const dedicated = entry(nested);
    const ensure = mock(async () => ({ entry: dedicated, reused: false }));
    pool.ensure = ensure;

    const routed = await pool.routeTarget(join(nested, 'src/index.ts'));

    expect(routed).toMatchObject({ entry: dedicated, detectedRoot: nested, servingRoot: nested, reused: false });
    expect(ensure).toHaveBeenCalledWith(nested, { isolate: true });
  });

  it('discovers once on a cold target and reuses the detected root for sibling calls', async () => {
    const root = fixture();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'package.json'), '{}');
    const discover = mock(() => root);
    const pool = new RootPool({ discoverProjectRoot: discover });
    const warm = entry(root);
    const ensure = mock(async () => ({ entry: warm, reused: false }));
    pool.ensure = ensure;

    const first = await pool.routeTarget(join(root, 'src/first.ts'));
    const second = await pool.routeTarget(join(root, 'src/second.ts'));

    expect(first.detectedRoot).toBe(root);
    expect(second.detectedRoot).toBe(root);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(ensure).toHaveBeenCalledTimes(2);
  });

  it('expires stale detected coverage and rediscovers without touching warm roots', async () => {
    const root = fixture();
    const stale = join(root, 'packages/old');
    mkdirSync(join(stale, 'src'), { recursive: true });
    const target = join(stale, 'src/index.ts');
    const discover = mock(() => root);
    const pool = new RootPool({ discoverProjectRoot: discover });
    const detected = (pool as unknown as { detectedRoots: Map<string, number> }).detectedRoots;
    detected.set(stale, Date.now() - IDLE_ROOT_MS - 1);
    const warm = entry(root);
    pool.ensure = mock(async () => ({ entry: warm, reused: false }));

    const routed = await pool.routeTarget(target);

    expect(routed.detectedRoot).toBe(root);
    expect(discover).toHaveBeenCalledTimes(1);
    expect(detected.has(stale)).toBe(true); // Fresh discovery records the stale target owner again.
  });

  it('keeps separate cached owners for targets in different repositories', async () => {
    const left = fixture();
    const right = fixture();
    mkdirSync(join(left, 'src'));
    mkdirSync(join(right, 'src'));
    const discover = mock((target: string) => target.startsWith(left) ? left : right);
    const pool = new RootPool({ discoverProjectRoot: discover });
    pool.ensure = mock(async (root: string) => ({ entry: entry(root), reused: false }));

    expect((await pool.routeTarget(join(left, 'src/a.ts'))).detectedRoot).toBe(left);
    expect((await pool.routeTarget(join(right, 'src/b.ts'))).detectedRoot).toBe(right);
    expect(discover).toHaveBeenCalledTimes(2);
  });
});

describe('RootPool tool calls', () => {
  it('preserves timeout bounds and the caller AbortSignal at the MCP request owner', async () => {
    const pool = new RootPool();
    const root = fixture();
    const controller = new AbortController();
    let receivedOptions: Record<string, unknown> | undefined;
    const toolEntry = entry(root);
    toolEntry.client = {
      callTool: async (_request: unknown, _schema: unknown, options: Record<string, unknown>) => {
        receivedOptions = options;
        return {};
      },
    } as unknown as RootEntry['client'];

    await pool.callTool(toolEntry, 'hover', { file: 'src/index.ts' }, controller.signal);

    expect(receivedOptions?.timeout).toBe(TOOL_TIMEOUT_MS);
    expect(receivedOptions?.maxTotalTimeout).toBe(TOOL_TIMEOUT_MS);
    expect(receivedOptions?.signal).toBe(controller.signal);
  });
});

describe('RootPool covering-root health', () => {
  it('stops offering a covering root that could not serve a path below it', async () => {
    // A root registered ABOVE a package -- what an Agent whose cwd is a Worktree
    // top registers by default -- may have no toolchain of its own. Handing it out
    // returns ITS failure for every nested request, for the daemon's lifetime, and
    // phrases it as a fact about the language rather than about the reused root.
    const pool = new RootPool({ discoverProjectRoot: () => undefined });
    const outer = fixture();
    const nested = join(outer, 'orqestra');
    mkdirSync(nested, { recursive: true });
    const covering = seedWarm(pool, outer);

    expect(pool.findCoveringRoot(nested)).toBe(covering);

    pool.markCoverageBroken(covering);

    expect(pool.findCoveringRoot(nested)).toBeUndefined();
  });

  it('keeps a retired covering root usable for its OWN exact root', async () => {
    // Retirement is about coverage, not about the root its caller actually asked
    // for: an exact-match request must still be served.
    const pool = new RootPool({ discoverProjectRoot: () => undefined });
    const outer = fixture();
    const covering = seedWarm(pool, outer);
    pool.markCoverageBroken(covering);

    expect(await pool.ensure(outer)).toMatchObject({ entry: covering, reused: true });
  });

  it('falls back to the next healthy covering root rather than to none', async () => {
    const pool = new RootPool({ discoverProjectRoot: () => undefined });
    const outer = fixture();
    const middle = join(outer, 'packages');
    const nested = join(middle, 'app');
    mkdirSync(nested, { recursive: true });
    const outerEntry = seedWarm(pool, outer);
    const middleEntry = seedWarm(pool, middle);

    expect(pool.findCoveringRoot(nested)).toBe(middleEntry);

    pool.markCoverageBroken(middleEntry);

    expect(pool.findCoveringRoot(nested)).toBe(outerEntry);
  });
});
