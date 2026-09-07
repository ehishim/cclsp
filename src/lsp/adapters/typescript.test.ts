import { describe, expect, jest, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { InitializeParams } from '../types.js';
import { TypeScriptAdapter } from './typescript.js';

function params(overrides: Partial<InitializeParams> = {}): InitializeParams {
  return {
    processId: 1,
    clientInfo: { name: 'cclsp', version: '0.0.0' },
    capabilities: { textDocument: { hover: {} }, workspace: { configuration: true } },
    rootUri: 'file:///workspace/project',
    workspaceFolders: [{ uri: 'file:///workspace/project', name: 'workspace' }],
    ...overrides,
  };
}

describe('TypeScriptAdapter', () => {
  const adapter = new TypeScriptAdapter();

  test('requests explicit diagnostic arrays and preserves positions', async () => {
    const calls: unknown[] = [];
    const state = {
      serverCapabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
      transport: {
        sendRequest: async (_method: string, input: unknown) => {
          calls.push(input);
          return {
            success: true,
            body:
              calls.length === 2
                ? [
                    {
                      message: 'Missing property',
                      category: 'error',
                      code: 2339,
                      startLocation: { line: 2, offset: 3 },
                      endLocation: { line: 2, offset: 8 },
                    },
                  ]
                : [],
          };
        },
      },
    };
    const result = await adapter.pullDiagnostics(state as never, '/project/file.ts', 1000);
    expect(calls).toHaveLength(3);
    expect(result).toEqual([
      {
        message: 'Missing property',
        code: 2339,
        source: 'typescript',
        severity: 1,
        range: { start: { line: 1, character: 2 }, end: { line: 1, character: 7 } },
      },
    ]);
  });

  test('does not turn unavailable request diagnostics into an empty answer', async () => {
    expect(
      await adapter.pullDiagnostics({ serverCapabilities: {} } as never, '/file.ts', 1000)
    ).toBeNull();
    const state = {
      serverCapabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
      transport: { sendRequest: async () => undefined },
    };
    await expect(adapter.pullDiagnostics(state as never, '/file.ts', 1000)).rejects.toThrow(
      'LSP_REQUEST_INVALID_RESPONSE'
    );
  });

  test('shares file readiness without changing workspace-wide readiness', async () => {
    let finish!: (value: unknown) => void;
    const reply = new Promise((resolve) => {
      finish = resolve;
    });
    const calls: Array<{ method: string; input: unknown; timeout: number }> = [];
    const state = {
      config: { extensions: ['ts'], command: ['typescript-language-server'], rootDir: '/project' },
      serverCapabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
      transport: {
        sendRequest: (method: string, input: unknown, timeout: number) => {
          calls.push({ method, input, timeout });
          return reply;
        },
      },
    };

    const first = adapter.waitForProjectReady(state as never, '/project/a.ts', 1000);
    const concurrent = adapter.waitForProjectReady(state as never, '/project/b.ts', 1000);
    expect(calls).toHaveLength(1);
    finish({ success: true, body: [] });
    expect(await Promise.all([first, concurrent])).toEqual([true, true]);
    expect(await adapter.waitForProjectReady(state as never, '/project/c.ts', 1000)).toBe(true);
    expect(state).not.toHaveProperty('indexingComplete');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      method: 'workspace/executeCommand',
      timeout: 1000,
      input: {
        command: 'typescript.tsserverRequest',
        arguments: [
          'semanticDiagnosticsSync',
          { file: '/project/a.ts', includeLinePosition: true },
          { executionTarget: 0 },
        ],
      },
    });
  });

  test('confirms independent configured subprojects separately', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-readiness-'));
    const firstRoot = join(root, 'first');
    const secondRoot = join(root, 'second');
    mkdirSync(firstRoot);
    mkdirSync(secondRoot);
    writeFileSync(join(firstRoot, 'tsconfig.json'), '{}');
    writeFileSync(join(secondRoot, 'tsconfig.json'), '{}');
    const calls: string[] = [];
    const state = {
      config: { extensions: ['ts'], command: ['typescript-language-server'], rootDir: root },
      serverCapabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
      transport: {
        sendRequest: async (_method: string, input: { arguments: [string, { file: string }] }) => {
          calls.push(input.arguments[1].file);
          return { success: true, body: [] };
        },
      },
    };
    try {
      expect(
        await Promise.all([
          adapter.waitForProjectReady(state as never, join(firstRoot, 'a.ts'), 1000),
          adapter.waitForProjectReady(state as never, join(secondRoot, 'b.ts'), 1000),
        ])
      ).toEqual([true, true]);
      expect(await adapter.waitForProjectReady(state as never, join(firstRoot, 'c.ts'), 1000)).toBe(
        true
      );
      expect(
        await adapter.waitForProjectReady(state as never, join(secondRoot, 'c.ts'), 1000)
      ).toBe(true);
      expect(calls).toEqual([join(firstRoot, 'a.ts'), join(secondRoot, 'b.ts')]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('does not confirm readiness from an unavailable or malformed provider response', async () => {
    expect(
      await adapter.waitForProjectReady(
        {
          config: { extensions: ['ts'], command: ['typescript-language-server'] },
          serverCapabilities: {},
          transport: { sendRequest: async () => undefined },
        } as never,
        '/file.ts',
        1000
      )
    ).toBe(false);
    const state = {
      config: { extensions: ['ts'], command: ['typescript-language-server'] },
      serverCapabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
      transport: { sendRequest: async () => ({ success: true, body: undefined }) },
    };
    expect(await adapter.waitForProjectReady(state as never, '/file.ts', 1000)).toBe(false);
  });

  test('clears failed project readiness so the same project can recover', async () => {
    const sendRequest = jest
      .fn()
      .mockRejectedValueOnce(new Error('request timeout'))
      .mockResolvedValueOnce({ success: true, body: [] });
    const state = {
      config: { extensions: ['ts'], command: ['typescript-language-server'] },
      serverCapabilities: { executeCommandProvider: { commands: ['typescript.tsserverRequest'] } },
      transport: { sendRequest },
    };

    expect(await adapter.waitForProjectReady(state as never, '/project/a.ts', 5)).toBe(false);
    expect(await adapter.waitForProjectReady(state as never, '/project/b.ts', 1000)).toBe(true);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });

  test('matches the typescript language server only', () => {
    expect(adapter.matches({ command: ['typescript-language-server', '--stdio'] } as never)).toBe(
      true
    );
    expect(adapter.matches({ command: ['gopls'] } as never)).toBe(false);
    expect(adapter.matches({ command: ['intelephense', '--stdio'] } as never)).toBe(false);
  });

  test('declares callHierarchy so the server advertises the provider', () => {
    // Without this the server correctly does not advertise callHierarchyProvider,
    // and prepare/incoming/outgoing calls report as unsupported by the LANGUAGE.
    const result = adapter.customizeInitializeParams(params());
    const capabilities = result.capabilities as {
      textDocument: { callHierarchy?: unknown; hover?: unknown };
    };

    expect(capabilities.textDocument.callHierarchy).toEqual({ dynamicRegistration: false });
  });

  test('preserves every capability it does not own', () => {
    const result = adapter.customizeInitializeParams(params());
    const capabilities = result.capabilities as {
      textDocument: { hover?: unknown };
      workspace?: unknown;
    };

    expect(capabilities.textDocument.hover).toEqual({});
    expect(capabilities.workspace).toEqual({ configuration: true });
  });

  test('injects no initializationOptions of its own', () => {
    // tsserver discovery is the server's job; supplying a path here would be a
    // fix with no defect behind it.
    expect(adapter.customizeInitializeParams(params()).initializationOptions).toBeUndefined();
  });

  test('preserves configured initializationOptions untouched', () => {
    const result = adapter.customizeInitializeParams(
      params({ initializationOptions: { tsserver: { path: '/explicit/tsserver.js' } } })
    );

    expect(result.initializationOptions).toEqual({ tsserver: { path: '/explicit/tsserver.js' } });
  });

  test('tolerates absent or non-object capabilities', () => {
    const result = adapter.customizeInitializeParams(params({ capabilities: undefined }));
    const capabilities = result.capabilities as { textDocument: { callHierarchy?: unknown } };

    expect(capabilities.textDocument.callHierarchy).toEqual({ dynamicRegistration: false });
  });
});
