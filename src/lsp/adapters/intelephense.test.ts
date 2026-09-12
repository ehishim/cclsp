import { describe, expect, test } from 'bun:test';
import type { InitializeParams } from '../types.js';
import { IntelephenseAdapter } from './intelephense.js';

describe('IntelephenseAdapter project readiness', () => {
  test('uses the official client initialization shape and onSave diagnostics', () => {
    const adapter = new IntelephenseAdapter();
    const params = {
      processId: 1,
      clientInfo: { name: 'cclsp', version: 'test' },
      capabilities: {},
      rootUri: 'file:///project',
      workspaceFolders: [],
    } as InitializeParams;
    expect(adapter.customizeInitializeParams(params).initializationOptions).toMatchObject({
      clearCache: false,
      isVscode: false,
    });
    expect(adapter.workspaceConfiguration([{}, {}])).toEqual([
      { diagnostics: { run: 'onSave' } },
      { diagnostics: { run: 'onSave' } },
    ]);
  });

  test('turns one didSave-caused publication into current request diagnostics', async () => {
    const adapter = new IntelephenseAdapter();
    let revision = 4;
    const notifications: unknown[] = [];
    const state = {
      diagnosticsCache: {
        revision: () => revision,
        waitForUpdate: async (_uri: string, after: number) => {
          revision++;
          return revision > after;
        },
        get: () => [
          {
            message: 'fresh',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          },
        ],
      },
      transport: {
        sendNotification: (method: string, params: unknown) =>
          notifications.push({ method, params }),
      },
    } as never;
    expect(await adapter.pullDiagnostics(state, '/project/a.php', 100)).toEqual([
      {
        message: 'fresh',
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      },
    ]);
    expect(notifications).toEqual([
      {
        method: 'textDocument/didSave',
        params: { textDocument: { uri: 'file:///project/a.php' } },
      },
    ]);
  });

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
