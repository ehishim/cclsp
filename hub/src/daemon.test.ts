// Covering-root recovery: which root serves a nested request, and whose failure
// the caller is told about when the retry also fails.

import { describe, expect, it } from 'bun:test';
import { InFlightRequests, callThroughRoute, resolveFilesystemParams } from './daemon.js';
import type { RootEntry, RoutedRoot } from './pool.js';

function entry(root: string, startedAt = Date.now()): RootEntry {
  return { root, client: {} as RootEntry['client'], pid: undefined, startedAt, lastUsed: startedAt };
}

function initErrorResult(text: string) {
  return { isError: true, content: [{ type: 'text', text }] };
}

function firstText(result: unknown): string {
  const content = (result as { content?: Array<{ text?: string }> }).content ?? [];
  return content[0]?.text ?? '';
}

/** A stale route shape retained only for the defensive post-routing recovery. */
function coveringRoute(covering: RootEntry): RoutedRoot {
  return { entry: covering, detectedRoot: covering.root, servingRoot: covering.root, reused: true };
}

function poolStub(options: {
  onCall: (root: string) => unknown;
  dedicated: RootEntry;
  owningRoot?: string;
}) {
  const retired: string[] = [];
  const ensured: string[] = [];
  return {
    retired,
    ensured,
    pool: {
      owningRoot(_target: string) {
        return options.owningRoot ?? options.dedicated.root;
      },
      async callTool(target: RootEntry, _name: string, _params: Record<string, unknown>) {
        const result = options.onCall(target.root);
        if (result instanceof Error) throw result;
        return result;
      },
      markCoverageBroken(target: RootEntry) {
        target.coverageBroken = true;
        retired.push(target.root);
      },
      async ensure(root: string) {
        ensured.push(root);
        return { entry: options.dedicated, reused: false };
      },
    },
  };
}

describe('Hub filesystem argument resolution', () => {
  it('resolves scalar paths, accumulated paths and move batches against the request root', () => {
    expect(resolveFilesystemParams({
      file_path: 'src/a.ts',
      path: ['src', '/absolute/pkg'],
      moves: [
        { old_path: 'src/a.ts', new_path: 'src/core/a.ts' },
        { old_path: '/absolute/b.php', new_path: '/absolute/core/b.php' },
      ],
    }, '/repo')).toEqual({
      file_path: '/repo/src/a.ts',
      path: ['/repo/src', '/absolute/pkg'],
      moves: [
        { old_path: '/repo/src/a.ts', new_path: '/repo/src/core/a.ts' },
        { old_path: '/absolute/b.php', new_path: '/absolute/core/b.php' },
      ],
    });
  });
});

describe('callThroughRoute cancellation', () => {
  it('cancels only the correlated request and retains accounting until settlement', () => {
    const requests = new InFlightRequests();
    const first = requests.start('client-1');
    const second = requests.start('client-2');

    expect(requests.cancel('client-1')).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(requests.cancel('client-1')).toBe(false);
    expect(second.signal.aborted).toBe(false);
    expect(requests.size).toBe(2);
    expect(requests.cancel('missing')).toBe(false);
    expect(() => requests.start('client-2')).toThrow('HUB_DUPLICATE_REQUEST_ID');

    requests.finish('client-1', first);
    expect(requests.size).toBe(1);
    expect(requests.cancel('client-1')).toBe(false);
    requests.finish('client-2', second);
    expect(requests.size).toBe(0);
  });

  it('passes the caller AbortSignal to the MCP request owner', async () => {
    const root = entry('/repo');
    const controller = new AbortController();
    let received: AbortSignal | undefined;
    const pool = {
      async callTool(_entry: RootEntry, _name: string, _params: Record<string, unknown>, signal?: AbortSignal) {
        received = signal;
        return { content: [{ type: 'text', text: 'ok' }] };
      },
      markCoverageBroken() {},
      async ensure() { return { entry: root, reused: true }; },
      owningRoot() { return root.root; },
    };
    const route: RoutedRoot = { entry: root, detectedRoot: root.root, servingRoot: root.root, reused: true };

    await callThroughRoute(pool as never, route, 'get_hover', {}, '/repo/a.ts', false, controller.signal);

    expect(received).toBe(controller.signal);
  });
});

describe('callThroughRoute covering-root recovery', () => {
  it('retires the covering root and answers from a dedicated one', async () => {
    const covering = entry('/repo');
    const dedicated = entry('/repo/pkg');
    const { pool, retired } = poolStub({
      dedicated,
      onCall: (root) =>
        root === '/repo'
          ? initErrorResult('Request initialize failed with message: Could not find a valid TypeScript installation.')
          : { content: [{ type: 'text', text: 'Document symbols (279/279)' }] },
    });
    const route = coveringRoute(covering);

    const result = await callThroughRoute(pool as never, route, 'get_document_symbols', {}, '/repo/pkg/src/a.ts');

    expect(firstText(result)).toContain('279/279');
    expect(retired).toEqual(['/repo']);
    // The route must now point at the root that actually served the answer, or
    // downstream cold-index age is read from a retired root.
    expect(route.entry).toBe(dedicated);
    expect(route.servingRoot).toBe('/repo/pkg');
    expect(route.reused).toBe(false);
  });

  it('reports the DEDICATED root failure, not the retired one, when the retry also fails', async () => {
    // Misattributing the failure is the exact defect this retry exists to stop:
    // the caller must see what went wrong with the root it asked for.
    const covering = entry('/repo');
    const dedicated = entry('/repo/pkg');
    const { pool } = poolStub({
      dedicated,
      onCall: (root) =>
        root === '/repo'
          ? initErrorResult('Request initialize failed with message: covering root has no TypeScript')
          : initErrorResult('Request initialize failed with message: dedicated root failed for its own reason'),
    });
    const route = coveringRoute(covering);

    const result = await callThroughRoute(pool as never, route, 'get_document_symbols', {}, '/repo/pkg/src/a.ts');
    const text = firstText(result);

    expect(text).toContain('dedicated root failed for its own reason');
    expect(text).not.toContain('covering root has no TypeScript');
    expect(text).not.toContain('covering root has no');
    // The retired root survives as CONTEXT so the caller can see why it was reached.
    expect(text).toContain('covering root /repo could not serve it');
  });

  it('leaves an exact-root call untouched', async () => {
    // Not a covering reuse: the caller asked for this root, so its failure is the
    // answer and nothing may be retired or retried behind its back.
    const exact = entry('/repo/pkg');
    const { pool, retired } = poolStub({
      dedicated: entry('/other'),
      owningRoot: '/repo/pkg',
      onCall: () => initErrorResult('Request initialize failed with message: no toolchain'),
    });
    const route: RoutedRoot = {
      entry: exact, detectedRoot: '/repo/pkg', servingRoot: '/repo/pkg', reused: true,
    };

    const result = await callThroughRoute(pool as never, route, 'get_document_symbols', {}, '/repo/pkg/src/a.ts');

    expect(firstText(result)).toBe('Request initialize failed with message: no toolchain');
    expect(retired).toEqual([]);
    expect(route.entry).toBe(exact);
  });

  it('does not retry a failure that is not a handshake failure', async () => {
    const covering = entry('/repo');
    const { pool, retired } = poolStub({
      dedicated: entry('/repo/pkg'),
      onCall: () => ({ isError: true, content: [{ type: 'text', text: 'symbol not found' }] }),
    });
    const route = coveringRoute(covering);

    const result = await callThroughRoute(pool as never, route, 'find_definition', {}, '/repo/pkg/src/a.ts');

    expect(firstText(result)).toBe('symbol not found');
    expect(retired).toEqual([]);
  });
});

describe('callThroughRoute defensive stale-route recovery', () => {
  it('re-discovers ownership when a previously routed covering root fails', async () => {
    // Project markers can change after initial routing. Recovery re-discovers the
    // owner instead of trusting stale detected/serving metadata.
    const covering = entry('/repo');
    const dedicated = entry('/repo/orqestra');
    const { pool, retired, ensured } = poolStub({
      dedicated,
      owningRoot: '/repo/orqestra',
      onCall: (root) =>
        root === '/repo'
          ? initErrorResult('Request initialize failed with message: Could not find a valid TypeScript installation.')
          : { content: [{ type: 'text', text: 'Document symbols (279/279)' }] },
    });
    const fastPath: RoutedRoot = {
      entry: covering, detectedRoot: covering.root, servingRoot: covering.root, reused: true,
    };

    const result = await callThroughRoute(
      pool as never, fastPath, 'get_document_symbols', {}, '/repo/orqestra/shared/a.ts',
    );

    expect(firstText(result)).toContain('279/279');
    expect(retired).toEqual(['/repo']);
    expect(ensured).toEqual(['/repo/orqestra']);
    expect(fastPath.detectedRoot).toBe('/repo/orqestra');
  });

  it('does not retire a root that genuinely owns the target', async () => {
    // Same fast-path shape, but the serving root IS the owning project: its failure
    // is the answer, and retiring it would strand the root the caller asked for.
    const owner = entry('/repo/orqestra');
    const { pool, retired, ensured } = poolStub({
      dedicated: entry('/unused'),
      owningRoot: '/repo/orqestra',
      onCall: () => initErrorResult('Request initialize failed with message: no toolchain here'),
    });
    const fastPath: RoutedRoot = {
      entry: owner, detectedRoot: owner.root, servingRoot: owner.root, reused: true,
    };

    const result = await callThroughRoute(
      pool as never, fastPath, 'get_document_symbols', {}, '/repo/orqestra/shared/a.ts',
    );

    expect(firstText(result)).toBe('Request initialize failed with message: no toolchain here');
    expect(retired).toEqual([]);
    expect(ensured).toEqual([]);
  });
});

describe('callThroughRoute explicit-root override', () => {
  /**
   * An explicit --root is an exact override. Even when the target is nested and
   * some narrower root genuinely owns it, the root the caller NAMED must answer.
   * Retiring it would redirect the call to a root the caller never asked for.
   */
  it('never retires or retries a caller-pinned root, even when a narrower root owns the target', async () => {
    const pinned = entry('/repo');
    const dedicated = entry('/repo/pkg');
    const { pool, retired, ensured } = poolStub({
      dedicated,
      owningRoot: '/repo/pkg',
      onCall: (root) =>
        root === '/repo'
          ? initErrorResult('Request initialize failed with message: Could not find a valid TypeScript installation.')
          : { content: [{ type: 'text', text: 'Document symbols (279/279)' }] },
    });
    const route: RoutedRoot = {
      entry: pinned,
      detectedRoot: pinned.root,
      servingRoot: pinned.root,
      reused: true,
    };

    const result = await callThroughRoute(pool, route, 'get_document_symbols', {}, '/repo/pkg/a.ts', true);

    expect(firstText(result)).toContain('Could not find a valid TypeScript installation');
    expect(retired).toEqual([]);
    expect(ensured).toEqual([]);
    expect(route.entry.root).toBe('/repo');
    expect(pinned.coverageBroken).toBeUndefined();
  });

  it('still recovers the default no-explicit-root path', async () => {
    const covering = entry('/repo');
    const dedicated = entry('/repo/pkg');
    const { pool, retired } = poolStub({
      dedicated,
      owningRoot: '/repo/pkg',
      onCall: (root) =>
        root === '/repo'
          ? initErrorResult('Request initialize failed with message: Could not find a valid TypeScript installation.')
          : { content: [{ type: 'text', text: 'Document symbols (279/279)' }] },
    });
    const route = coveringRoute(covering);

    const result = await callThroughRoute(pool, route, 'get_document_symbols', {}, '/repo/pkg/a.ts');

    expect(firstText(result)).toContain('279/279');
    expect(retired).toEqual(['/repo']);
  });
});
