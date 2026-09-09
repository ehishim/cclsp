// Batch hover shares freshness and drains all active requests before releasing its lease.
import { expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hoverBatch } from './operations.js';
import type { ServerState } from './types.js';

it('checks freshness once and preserves ordered results with bounded concurrency', async () => {
  const root = await mkdtemp(join(tmpdir(), 'hover-batch-'));
  const file = join(root, 'a.ts');
  await writeFile(file, 'export const a = 1;');
  let acquired = 0;
  let released = 0;
  let active = 0;
  let peak = 0;
  const state = {
    initializationPromise: Promise.resolve(),
    serverCapabilities: { hoverProvider: true },
    config: { command: ['fixture'] },
    documentManager: {
      acquire: async () => {
        acquired++;
        return {
          justOpened: true,
          release: () => {
            expect(active).toBe(0);
            released++;
          },
        };
      },
      getSyncSig: () => undefined,
      setSyncSig: () => {},
    },
    transport: {
      sendRequest: async (_method: string, params: { position: { line: number } }) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return { contents: String(params.position.line) };
      },
    },
  } as unknown as ServerState;
  try {
    const positions = Array.from({ length: 100 }, (_, line) => ({ line, character: 0 }));
    const result = await hoverBatch(state, file, positions);
    expect(result.map((row) => row?.contents)).toEqual(positions.map((p) => String(p.line)));
    expect(acquired).toBe(1);
    expect(released).toBe(1);
    expect(peak).toBeLessThanOrEqual(8);
    let requests = 0;
    state.transport.sendRequest = async () => {
      const current = requests++;
      active++;
      try {
        await new Promise((resolve) => setTimeout(resolve, current === 0 ? 1 : 5));
        if (current === 0) throw new Error('provider failure');
        return { contents: 'finished' };
      } finally {
        active--;
      }
    };
    await expect(hoverBatch(state, file, positions)).rejects.toThrow('provider failure');
    expect(active).toBe(0);
    expect(released).toBe(2);
    expect(requests).toBeLessThanOrEqual(8);
    state.transport.sendRequest = async () => {
      await writeFile(file, 'export const a = 2;');
      return { contents: 'changed' };
    };
    await expect(hoverBatch(state, file, [{ line: 0, character: 13 }])).rejects.toThrow(
      'source changed during the hover batch'
    );
    expect(released).toBe(3);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
