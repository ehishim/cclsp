// Diagnostics must synchronize imported open buffers before requesting a fresh answer.
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DiagnosticsCache } from './diagnostics.js';
import { DocumentManager } from './document-manager.js';
import { getDiagnostics, getDiagnosticsBatch, getDiagnosticsReport } from './operations.js';
import type { ServerState } from './types.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cclsp-freshness-'));
  roots.push(root);
  const owner = join(root, 'owner.ts');
  const consumer = join(root, 'consumer.ts');
  writeFileSync(owner, 'export interface Value { old: string }');
  writeFileSync(
    consumer,
    'import type { Value } from "./owner"; export const read = (v: Value) => v.old;'
  );
  const transport = { sendNotification() {}, sendRequest: async () => [] };
  const dm = new DocumentManager(transport as never);
  const state = {
    initializationPromise: Promise.resolve(),
    documentManager: dm,
    diagnosticsCache: new DiagnosticsCache(),
    serverCapabilities: {},
    transport,
    adapter: {
      pullDiagnostics: async () =>
        dm.getText(owner)?.includes('new:')
          ? [
              {
                message: 'old is missing',
                code: 2339,
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
              },
            ]
          : [],
    },
  } as unknown as ServerState;
  return { owner, consumer, dm, state };
}

describe('diagnostic freshness', () => {
  it('refreshes an imported owner even with unchanged size and restored timestamps', async () => {
    const { owner, consumer, dm, state } = fixture();
    const date = new Date(1_000_000_000_000);
    utimesSync(owner, date, date);
    const lease = await dm.acquire(owner);
    lease.release();
    expect(await getDiagnostics(state, consumer)).toEqual([]);
    writeFileSync(owner, 'export interface Value { new: string }');
    utimesSync(owner, date, date);
    expect((await getDiagnostics(state, consumer))[0]?.code).toBe(2339);
    expect((await getDiagnosticsBatch(state, [consumer]))[0]?.diagnostics[0]?.code).toBe(2339);
    writeFileSync(owner, 'export interface Value { old: string }');
    expect(await getDiagnostics(state, consumer)).toEqual([]);
  });

  it('refuses to infer a clean result from a provider without request diagnostics', async () => {
    const { consumer, state } = fixture();
    state.adapter = undefined;
    await expect(getDiagnostics(state, consumer)).rejects.toThrow('LSP_DIAGNOSTICS_UNKNOWN');
  });

  it('rejects forged writer scopes and waits for a real writer before reconciling', async () => {
    const { owner, dm } = fixture();
    const lease = await dm.acquire(owner);
    lease.release();
    expect(() => dm.changeUnderScope(owner, 'wrong', { epoch: dm.epoch })).toThrow(
      'LSP_WRITE_SCOPE_INVALID'
    );
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const writer = dm.withWriter(async () => {
      entered();
      await expect(dm.reconcile()).rejects.toThrow('writers cannot reconcile');
      await blocked;
    });
    await started;
    let settled = false;
    const read = dm.reconcile().then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    unblock();
    await writer;
    await read;
    expect(settled).toBe(true);
  });

  it('times out an unrelated read during a slow writer and recovers after release', async () => {
    const { owner, dm } = fixture();
    (await dm.acquire(owner)).release();
    let unblock!: () => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const blocked = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    const writer = dm.withWriter(async () => {
      entered();
      await blocked;
    });
    await started;
    const begin = performance.now();
    try {
      await expect(dm.reconcile()).rejects.toThrow('LSP_FRESHNESS_UNKNOWN');
      expect(performance.now() - begin).toBeLessThan(6000);
    } finally {
      unblock();
      await writer;
    }
    expect((await dm.reconcile()).contents.has(owner)).toBe(true);
  }, 10000);

  it('detects a disk edit during an outstanding diagnostics request', async () => {
    const { owner, consumer, dm, state } = fixture();
    (await dm.acquire(owner)).release();
    state.adapter = {
      name: 'fixture',
      matches: () => true,
      pullDiagnostics: async () => {
        writeFileSync(owner, 'export interface Value { new: string }');
        return [];
      },
    };
    await expect(getDiagnostics(state, consumer)).rejects.toThrow('LSP_FRESHNESS_UNKNOWN');
  });

  it('preserves identical unverified rows and changed paths in single and batch reports', async () => {
    const { owner, consumer, dm, state } = fixture();
    (await dm.acquire(owner)).release();
    const original = 'export interface Value { old: string }';
    const row = {
      message: 'observed before write',
      code: 2339,
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
    };
    state.adapter = {
      name: 'fixture',
      matches: () => true,
      pullDiagnostics: async () => {
        writeFileSync(owner, 'export interface Value { new: string }');
        return [row];
      },
    };
    const single = await getDiagnosticsReport(state, consumer);
    writeFileSync(owner, original);
    const [batch] = await getDiagnosticsBatch(state, [consumer]);
    expect(single.diagnostics).toEqual([row]);
    expect(batch?.diagnostics).toEqual(single.diagnostics);
    expect(single.freshness.status).toBe('unverified');
    expect(batch?.freshness?.status).toBe('unverified');
    expect(single.freshness.changedDuringRequest).toEqual([owner]);
    expect(batch?.freshness?.changedDuringRequest).toEqual([owner]);
  });

  it('releases a read lease correctly after its open document is renamed', async () => {
    const { owner, consumer, dm } = fixture();
    const lease = await dm.acquire(owner);
    await dm.withWriter(async (scope) => dm.renameOpenDocument(owner, consumer, scope));
    lease.release();
    expect(dm.isOpen(owner)).toBe(false);
    expect(dm.isOpen(consumer)).toBe(true);
  });

  it('bounds mixed concurrent read chunks and releases every reservation', async () => {
    const { owner, consumer } = fixture();
    const dm = new DocumentManager({ sendNotification() {} } as never, 2);
    let active = 0;
    let maximum = 0;
    await Promise.all(
      Array.from({ length: 20 }, async (_, index) => {
        const leases =
          index % 2 ? [await dm.acquire(owner)] : await dm.acquireChunk([owner, consumer]);
        active += leases.length;
        maximum = Math.max(maximum, active);
        await Promise.resolve();
        active -= leases.length;
        for (const lease of leases) lease.release();
      })
    );
    expect(maximum).toBeLessThanOrEqual(2);
    expect(active).toBe(0);
    expect(dm.getOpenCount()).toBeLessThanOrEqual(2);
  });

  it('queues a complete read chunk without holding partial document capacity', async () => {
    const { owner, consumer } = fixture();
    const dm = new DocumentManager({ sendNotification() {} } as never, 1);
    const first = await dm.acquire(owner);
    let acquired = false;
    const next = dm.acquireChunk([consumer]).then((leases) => {
      acquired = true;
      return leases;
    });
    await Promise.resolve();
    expect(acquired).toBe(false);
    first.release();
    for (const lease of await next) lease.release();
    expect(dm.getOpenCount()).toBe(1);
  });
});
