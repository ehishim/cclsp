import { describe, expect, test } from 'bun:test';
import { IntelephenseAdapter } from './intelephense.js';

describe('IntelephenseAdapter project readiness', () => {
  test('releases every concurrent waiter only after indexing ends', async () => {
    const adapter = new IntelephenseAdapter();
    const state = {} as never;

    expect(adapter.handleNotification('indexingStarted', {}, state)).toBe(true);
    const first = adapter.waitForProjectReady(state, '/project/a.php', 1000);
    const concurrent = adapter.waitForProjectReady(state, '/project/b.php', 1000);
    adapter.handleNotification('indexingEnded', {}, state);

    expect(await Promise.all([first, concurrent])).toEqual([true, true]);
    expect(await adapter.waitForProjectReady(state, '/project/c.php', 1000)).toBe(true);
  });

  test('returns a bounded non-answer when indexing never completes', async () => {
    const adapter = new IntelephenseAdapter();
    const state = {} as never;

    expect(await adapter.waitForProjectReady(state, '/project/a.php', 5)).toBe(false);
  });
});
