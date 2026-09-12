import { beforeEach, describe, expect, it, jest, spyOn } from 'bun:test';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { LSPClient } from './lsp-client.js';
import { LspToolOutcomeError } from './lsp/capabilities.js';
import * as operations from './lsp/operations.js';
import { pathToUri, uriToPath } from './utils.js';

// Type for accessing private methods in tests
type LSPClientInternal = {
  getServer: (filePath: string) => Promise<{ initializationPromise: Promise<void> }>;
};

/** Create a mock transport for test server states */
function createMockTransport(
  overrides?: Partial<{
    sendRequest: (...args: unknown[]) => Promise<unknown>;
    sendNotification: (...args: unknown[]) => void;
    sendMessage: (...args: unknown[]) => void;
  }>
) {
  return {
    sendRequest: overrides?.sendRequest ?? jest.fn().mockResolvedValue(undefined),
    sendNotification: overrides?.sendNotification ?? jest.fn(),
    sendMessage: overrides?.sendMessage ?? jest.fn(),
  };
}

/** Create a mock DiagnosticsCache for test server states */
function createMockDiagnosticsCache(initial?: Map<string, unknown[]>) {
  const diagnostics = initial ?? new Map();
  return {
    get: jest.fn((uri: string) => diagnostics.get(uri)),
    delete: jest.fn(),
    update: jest.fn(),
    waitForIdle: jest.fn().mockResolvedValue(undefined),
    waitForAllIdle: jest.fn().mockResolvedValue(undefined),
  };
}

/** Create a mock DocumentManager for test server states */
function createMockDocumentManager() {
  const sendChange = jest.fn();
  return {
    withWriter: jest.fn(async (action: (scope: { epoch: number }) => Promise<unknown>) =>
      action({ epoch: 0 })
    ),
    changeUnderScope: jest.fn((path: string, text: string) => sendChange(path, text)),
    reconcile: jest
      .fn()
      .mockResolvedValue({ epoch: 0, contents: new Map(), resynced: [], bytesCompared: 0 }),
    changedSince: jest.fn().mockResolvedValue([]),
    capacity: 100,
    acquireChunk: jest.fn().mockResolvedValue([{ justOpened: true, release: jest.fn() }]),
    ensureOpen: jest.fn().mockResolvedValue(false),
    acquire: jest.fn().mockResolvedValue({ justOpened: true, release: jest.fn() }),
    sendChange,
    isOpen: jest.fn().mockReturnValue(false),
    getVersion: jest.fn().mockReturnValue(0),
    getSyncSig: jest.fn().mockReturnValue(undefined),
    setSyncSig: jest.fn(),
  };
}

const TEST_DIR = join(tmpdir(), 'cclsp-test');

const TEST_CONFIG_PATH = join(TEST_DIR, 'test-config.json');

// Platform-neutral absolute paths for test fixtures
const MOCK_TEST_TS = join(tmpdir(), 'test.ts');
const MOCK_IMPL_TS = join(tmpdir(), 'impl.ts');
const MOCK_IMPL1_TS = join(tmpdir(), 'impl1.ts');
const MOCK_IMPL2_TS = join(tmpdir(), 'impl2.ts');
const MOCK_CALLER1_TS = join(tmpdir(), 'caller1.ts');
const MOCK_CALLEE1_TS = join(tmpdir(), 'callee1.ts');

function queryOccurrences(
  name: string,
  matches: Array<{ line: number; character: number; importBinding?: boolean }>,
  truncated = false
) {
  return {
    occurrences: matches.map((match) => ({
      range: {
        start: { line: match.line, character: match.character },
        end: { line: match.line, character: match.character + name.length },
      },
      importBinding: match.importBinding ?? false,
    })),
    truncated,
  };
}

const MOCK_SERVER_CAPABILITIES = {
  definitionProvider: true,
  referencesProvider: true,
  renameProvider: { prepareProvider: true },
  documentSymbolProvider: true,
  hoverProvider: true,
  workspaceSymbolProvider: true,
  implementationProvider: true,
  callHierarchyProvider: true,
  completionProvider: {},
  signatureHelpProvider: {},
  codeActionProvider: true,
  diagnosticProvider: true,
};

describe('LSPClient', () => {
  beforeEach(async () => {
    // Ensure CCLSP_CONFIG_PATH is truly unset to avoid cross-test contamination.
    // Must use Reflect.deleteProperty (not `= undefined` which coerces to string "undefined" on Windows).
    Reflect.deleteProperty(process.env, 'CCLSP_CONFIG_PATH');

    // Clean up test directory
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }

    mkdirSync(TEST_DIR, { recursive: true });

    // Create test config file
    const testConfig = {
      servers: [
        {
          extensions: ['ts', 'js', 'tsx', 'jsx'],
          command: ['npx', '--', 'typescript-language-server', '--stdio'],
          rootDir: '.',
        },
      ],
    };

    const configContent = JSON.stringify(testConfig, null, 2);

    // Use async file operations for better CI compatibility
    await writeFile(TEST_CONFIG_PATH, configContent);

    // Small delay to ensure filesystem consistency
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify file creation with retry logic for CI environments
    let fileExists = existsSync(TEST_CONFIG_PATH);
    let retries = 0;
    while (!fileExists && retries < 10) {
      await new Promise((resolve) => setTimeout(resolve, 100));
      fileExists = existsSync(TEST_CONFIG_PATH);
      retries++;
    }

    if (!fileExists) {
      throw new Error(
        `Failed to create config file at ${TEST_CONFIG_PATH} after ${retries} retries`
      );
    }
  });

  it('should fail to create LSPClient when config file does not exist', () => {
    const savedEnv = process.env.CCLSP_CONFIG_PATH;
    Reflect.deleteProperty(process.env, 'CCLSP_CONFIG_PATH');
    const badPath = join(tmpdir(), 'nonexistent', 'config.json');
    try {
      expect(() => {
        new LSPClient(badPath);
      }).toThrow(`Failed to load config from ${badPath}`);
    } finally {
      if (savedEnv !== undefined) {
        process.env.CCLSP_CONFIG_PATH = savedEnv;
      }
    }
  });

  it('should fail to create LSPClient when no configPath provided', () => {
    const savedEnv = process.env.CCLSP_CONFIG_PATH;
    Reflect.deleteProperty(process.env, 'CCLSP_CONFIG_PATH');
    try {
      expect(() => {
        new LSPClient();
      }).toThrow('configPath is required when CCLSP_CONFIG_PATH environment variable is not set');
    } finally {
      if (savedEnv !== undefined) {
        process.env.CCLSP_CONFIG_PATH = savedEnv;
      }
    }
  });

  it('should create LSPClient with valid config file', () => {
    const client = new LSPClient(TEST_CONFIG_PATH);
    expect(client).toBeDefined();
  });

  describe('preloadServers', () => {
    it('should scan directory and find file extensions', async () => {
      // Create test files with different extensions
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');
      await writeFile(join(TEST_DIR, 'test.js'), 'console.log("test");');
      await writeFile(join(TEST_DIR, 'test.py'), 'print("test")');

      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock process.stderr.write to capture output
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Mock serverManager.getServer to avoid actually starting LSP servers
      const getServerSpy = spyOn((client as any).serverManager, 'getServer').mockImplementation(
        async () => ({
          process: { kill: jest.fn() },
          initialized: true,
          documentManager: createMockDocumentManager(),
        })
      );

      await client.preloadServers(false);

      // Should attempt to start TypeScript server for .ts and .js files
      expect(getServerSpy).toHaveBeenCalled();

      stderrSpy.mockRestore();
      getServerSpy.mockRestore();
    });

    it('should handle missing .gitignore gracefully', async () => {
      // Create test file without .gitignore
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');

      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock serverManager.getServer
      const getServerSpy = spyOn((client as any).serverManager, 'getServer').mockImplementation(
        async () => ({
          process: { kill: jest.fn() },
          initialized: true,
          documentManager: createMockDocumentManager(),
        })
      );

      // Should not throw error
      await expect(async () => {
        await client.preloadServers(false);
      }).not.toThrow();

      getServerSpy.mockRestore();
    });

    it.skip('should handle preloading errors gracefully', async () => {
      await writeFile(join(TEST_DIR, 'test.ts'), 'console.log("test");');

      const client = new LSPClient(TEST_CONFIG_PATH);

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);

      // Mock serverManager.getServer to throw error
      const getServerSpy = spyOn((client as any).serverManager, 'getServer').mockRejectedValue(
        new Error('Failed to start server')
      );

      // Should complete without throwing
      await client.preloadServers(false);

      // Should have logged the error to stderr
      expect(stderrSpy).toHaveBeenCalled();

      getServerSpy.mockRestore();
      stderrSpy.mockRestore();
    });
  });

  describe('initialization promise behavior', () => {
    it.skip('should wait for initialization on first call and pass through on subsequent calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      let initResolve: (() => void) | undefined;
      const initPromise = new Promise<void>((resolve) => {
        initResolve = resolve;
      });

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue([]),
      });

      // Mock getServer to return a server state with our controlled promise
      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: initPromise,
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: false,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      // Start first call (should wait)
      const firstCallPromise = client.findDefinition('test.ts', {
        line: 0,
        character: 0,
      });

      // Wait a bit to ensure call is waiting
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Resolve initialization
      initResolve?.();

      // Wait for call to complete
      await firstCallPromise;

      // Verify call was made
      expect(mockTransport.sendRequest).toHaveBeenCalled();

      getServerSpy.mockRestore();
    });

    it('should handle multiple concurrent calls waiting for initialization', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      let initResolve: (() => void) | undefined;
      const initPromise = new Promise<void>((resolve) => {
        initResolve = resolve;
      });

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue([]),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: initPromise,
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: false,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      // Start multiple concurrent calls
      const promises = [
        client.findDefinition('test.ts', { line: 0, character: 0 }),
        client.findReferences('test.ts', { line: 1, character: 0 }),
        client.renameSymbol('test.ts', { line: 2, character: 0 }, 'newName'),
      ];

      // Wait a bit to ensure all are waiting
      await new Promise((resolve) => setTimeout(resolve, 50));

      // Resolve initialization - all should proceed
      initResolve?.();

      // All calls should complete successfully
      const results = await Promise.all(promises);
      expect(results).toHaveLength(3);

      // Definition and references send one request each; rename prepares before mutating.
      expect(mockTransport.sendRequest).toHaveBeenCalledTimes(4);

      getServerSpy.mockRestore();
    });
  });

  describe('Symbol kind fallback functionality', () => {
    it('should return fallback results when specified symbol kind not found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock getDocumentSymbols to return test symbols
      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 21 },
          },
        },
        {
          name: 'testVariable',
          kind: 13, // Variable
          range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 20 },
          },
          selectionRange: {
            start: { line: 3, character: 6 },
            end: { line: 3, character: 18 },
          },
        },
      ];

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
      };
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const getDocumentSymbolsSpy = spyOn(operations, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'testFunction' with kind 'class' (should not match, then fallback to all kinds)
      const result = await client.findSymbolsByName('test.ts', 'testFunction', 'class');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('testFunction');
      expect(result.matches[0]?.kind).toBe(12); // Function
      expect(result.warning).toContain('No symbols found with kind "class"');
      expect(result.warning).toContain(
        'Found 1 symbol(s) with name "testFunction" of other kinds: function'
      );

      getDocumentSymbolsSpy.mockRestore();
      getServerSpy.mockRestore();
    });

    it('should return multiple fallback results of different kinds', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      // Mock getDocumentSymbols to return symbols with same name but different kinds
      const mockSymbols = [
        {
          name: 'test',
          kind: 12, // Function
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 13 },
          },
        },
        {
          name: 'test',
          kind: 13, // Variable
          range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 15 },
          },
          selectionRange: {
            start: { line: 3, character: 6 },
            end: { line: 3, character: 10 },
          },
        },
        {
          name: 'test',
          kind: 5, // Class
          range: {
            start: { line: 5, character: 0 },
            end: { line: 10, character: 1 },
          },
          selectionRange: {
            start: { line: 5, character: 6 },
            end: { line: 5, character: 10 },
          },
        },
      ];

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
      };
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const getDocumentSymbolsSpy = spyOn(operations, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'test' with kind 'interface' (should not match, then fallback to all kinds)
      const result = await client.findSymbolsByName('test.ts', 'test', 'interface');

      expect(result.matches).toHaveLength(3);
      expect(result.warning).toContain('No symbols found with kind "interface"');
      expect(result.warning).toContain(
        'Found 3 symbol(s) with name "test" of other kinds: function, variable, class'
      );

      getDocumentSymbolsSpy.mockRestore();
      getServerSpy.mockRestore();
    });

    it('should not trigger fallback when correct symbol kind is found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 21 },
          },
        },
        {
          name: 'testVariable',
          kind: 13, // Variable
          range: {
            start: { line: 3, character: 0 },
            end: { line: 3, character: 20 },
          },
          selectionRange: {
            start: { line: 3, character: 6 },
            end: { line: 3, character: 18 },
          },
        },
      ];

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
      };
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const getDocumentSymbolsSpy = spyOn(operations, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for 'testFunction' with correct kind 'function'
      const result = await client.findSymbolsByName('test.ts', 'testFunction', 'function');

      expect(result.matches).toHaveLength(1);
      expect(result.matches[0]?.name).toBe('testFunction');
      expect(result.warning).toBeUndefined(); // No warning expected

      getDocumentSymbolsSpy.mockRestore();
      getServerSpy.mockRestore();
    });

    it('groups a property and a later import as different semantic candidates', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const symbolsSpy = spyOn(client, 'getDocumentSymbolsWithProvider').mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [
          {
            name: 'ImportedAlias',
            kind: 7,
            range: { start: { line: 0, character: 12 }, end: { line: 0, character: 28 } },
            selectionRange: { start: { line: 0, character: 14 }, end: { line: 0, character: 27 } },
          },
        ],
      });
      const findOccurrences = jest
        .fn()
        .mockResolvedValue(
          queryOccurrences('ImportedAlias', [{ line: 1, character: 14, importBinding: true }])
        );
      (
        client as unknown as { astProvider: { queryOccurrences: typeof findOccurrences } }
      ).astProvider = {
        queryOccurrences: findOccurrences,
      };
      const definition = spyOn(client, 'findDefinition').mockImplementation(
        async (_file, position) => [
          position.line === 0
            ? {
                uri: pathToUri(MOCK_TEST_TS),
                range: {
                  start: position,
                  end: { ...position, character: position.character + 13 },
                },
              }
            : {
                uri: pathToUri(MOCK_TEST_TS),
                range: { start: { line: 1, character: 14 }, end: { line: 1, character: 27 } },
              },
        ]
      );
      const typeDefinition = spyOn(client, 'findTypeDefinition').mockImplementation(
        async (_file, position) =>
          position.line === 0
            ? []
            : [
                {
                  uri: pathToUri(MOCK_IMPL_TS),
                  range: { start: { line: 10, character: 17 }, end: { line: 10, character: 30 } },
                },
              ]
      );

      const result = await client.findSymbolsByName(MOCK_TEST_TS, 'ImportedAlias');

      expect(result.matches).toHaveLength(2);
      expect(result.matches.map((match) => match.position.line)).toEqual([0, 1]);
      expect(result.matches[1]?.definitionLocations).toEqual([
        expect.objectContaining({ uri: pathToUri(MOCK_IMPL_TS) }),
      ]);
      expect(typeDefinition).toHaveBeenCalledTimes(1);
      expect(typeDefinition).toHaveBeenCalledWith(MOCK_TEST_TS, { line: 1, character: 14 });
      expect(findOccurrences).toHaveBeenCalledWith(MOCK_TEST_TS, 'ImportedAlias', 32);
      typeDefinition.mockRestore();
      definition.mockRestore();
      symbolsSpy.mockRestore();
    });

    it('reports when bounded use-only occurrences may omit another semantic target', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const symbolsSpy = spyOn(client, 'getDocumentSymbolsWithProvider').mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
      });
      const findOccurrences = jest.fn().mockResolvedValue(
        queryOccurrences(
          'RepeatedAlias',
          [
            { line: 0, character: 7 },
            { line: 1, character: 7 },
          ],
          true
        )
      );
      (
        client as unknown as { astProvider: { queryOccurrences: typeof findOccurrences } }
      ).astProvider = {
        queryOccurrences: findOccurrences,
      };
      const definition = spyOn(client, 'findDefinition').mockImplementation(
        async (_file, position) => [
          {
            uri: pathToUri(position.line === 0 ? MOCK_IMPL1_TS : MOCK_IMPL2_TS),
            range: { start: { line: 3, character: 4 }, end: { line: 3, character: 17 } },
          },
        ]
      );

      const result = await client.findSymbolsByName(MOCK_TEST_TS, 'RepeatedAlias');

      expect(result.matches).toHaveLength(2);
      expect(result.incomplete).toBe(true);
      expect(result.warning).toContain('exceeded the 32 result bound');
      expect(result.warning).toContain('use an exact position');
      expect(result.warning).toContain('at least 2 visible semantic symbols');
      expect(result.warning).toContain('may contain more');
      definition.mockRestore();
      symbolsSpy.mockRestore();
    });

    it('does not request typeDefinition for an ordinary remote definition', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const symbolsSpy = spyOn(client, 'getDocumentSymbolsWithProvider').mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
      });
      const findOccurrences = jest
        .fn()
        .mockResolvedValue(queryOccurrences('ImportedAlias', [{ line: 2, character: 20 }]));
      (
        client as unknown as { astProvider: { queryOccurrences: typeof findOccurrences } }
      ).astProvider = {
        queryOccurrences: findOccurrences,
      };
      const definition = spyOn(client, 'findDefinition').mockResolvedValue([
        {
          uri: pathToUri(MOCK_IMPL_TS),
          range: { start: { line: 10, character: 17 }, end: { line: 10, character: 30 } },
        },
      ]);
      const typeDefinition = spyOn(client, 'findTypeDefinition');

      const result = await client.findDefinitionsWithProvider(MOCK_TEST_TS, 'ImportedAlias');

      expect(typeDefinition).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        outcome: 'ok',
        provider: 'lsp',
        value: [{ uri: pathToUri(MOCK_IMPL_TS) }],
      });
      typeDefinition.mockRestore();
      definition.mockRestore();
      symbolsSpy.mockRestore();
    });

    it('preserves an alias definition when typeDefinition is unsupported', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const symbolsSpy = spyOn(client, 'getDocumentSymbolsWithProvider').mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
      });
      const findOccurrences = jest
        .fn()
        .mockResolvedValue(
          queryOccurrences('ImportedAlias', [{ line: 1, character: 14, importBinding: true }])
        );
      (
        client as unknown as { astProvider: { queryOccurrences: typeof findOccurrences } }
      ).astProvider = {
        queryOccurrences: findOccurrences,
      };
      const aliasLocation = {
        uri: pathToUri(MOCK_TEST_TS),
        range: { start: { line: 1, character: 14 }, end: { line: 1, character: 27 } },
      };
      const definition = spyOn(client, 'findDefinition').mockResolvedValue([aliasLocation]);
      const typeDefinition = spyOn(client, 'findTypeDefinition').mockResolvedValue([]);

      const result = await client.findDefinitionsWithProvider(MOCK_TEST_TS, 'ImportedAlias');

      expect(result).toMatchObject({ outcome: 'ok', provider: 'lsp', value: [aliasLocation] });
      typeDefinition.mockRestore();
      definition.mockRestore();
      symbolsSpy.mockRestore();
    });

    it('should not reinterpret an expression-shaped query as a symbol occurrence', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const symbolsSpy = spyOn(client, 'getDocumentSymbolsWithProvider').mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
      });
      const findOccurrences = jest.fn();
      (
        client as unknown as { astProvider: { queryOccurrences: typeof findOccurrences } }
      ).astProvider = {
        queryOccurrences: findOccurrences,
      };

      const result = await client.findSymbolsByName(MOCK_TEST_TS, 'alpha|omega');

      expect(result.matches).toHaveLength(0);
      expect(findOccurrences).not.toHaveBeenCalled();
      symbolsSpy.mockRestore();
    });

    it('should preserve honest absence when neither declarations nor syntax contain the query', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const symbolsSpy = spyOn(client, 'getDocumentSymbolsWithProvider').mockResolvedValue({
        outcome: 'ok',
        provider: 'lsp',
        value: [],
      });
      const findOccurrences = jest.fn().mockResolvedValue(queryOccurrences('ReallyAbsent', []));
      (
        client as unknown as { astProvider: { queryOccurrences: typeof findOccurrences } }
      ).astProvider = {
        queryOccurrences: findOccurrences,
      };

      const result = await client.findSymbolsByName(MOCK_TEST_TS, 'ReallyAbsent');

      expect(result.matches).toHaveLength(0);
      expect(result.warning).toBeUndefined();
      symbolsSpy.mockRestore();
    });

    it('should return empty results when no symbols found even with fallback', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'otherFunction',
          kind: 12, // Function
          range: {
            start: { line: 0, character: 0 },
            end: { line: 2, character: 1 },
          },
          selectionRange: {
            start: { line: 0, character: 9 },
            end: { line: 0, character: 22 },
          },
        },
      ];

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
      };
      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const getDocumentSymbolsSpy = spyOn(operations, 'getDocumentSymbols').mockResolvedValue(
        mockSymbols
      );

      // Search for non-existent symbol
      const result = await client.findSymbolsByName('test.ts', 'nonExistentSymbol', 'function');

      expect(result.matches).toHaveLength(0);
      expect(result.warning).toBeUndefined(); // No fallback triggered since no name matches found

      getDocumentSymbolsSpy.mockRestore();
      getServerSpy.mockRestore();
    });
  });

  describe('Server restart functionality', () => {
    it('should setup restart timer when restartInterval is configured', () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      // Mock setTimeout to verify timer is set
      const setTimeoutSpy = spyOn(global, 'setTimeout').mockImplementation((() => 123) as any);

      const mockServerState = {
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        documentManager: createMockDocumentManager(),
        startTime: Date.now(),
        config: {
          extensions: ['ts'],
          command: ['echo', 'mock'],
          restartInterval: 0.1, // 0.1 minutes
        },
        restartTimer: undefined,
      };

      try {
        // Call setupRestartTimer on serverManager
        (serverManager as any).setupRestartTimer(mockServerState);

        // Verify setTimeout was called with correct interval (0.1 minutes = 6000ms)
        expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 6000);
      } finally {
        setTimeoutSpy.mockRestore();
        client.dispose();
      }
    });

    it('should not setup restart timer when restartInterval is not configured', () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      // Mock setTimeout to verify timer is NOT set
      const setTimeoutSpy = spyOn(global, 'setTimeout').mockImplementation((() => 123) as any);

      const mockServerState = {
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        documentManager: createMockDocumentManager(),
        startTime: Date.now(),
        config: {
          extensions: ['ts'],
          command: ['echo', 'mock'],
          // No restartInterval
        },
        restartTimer: undefined,
      };

      try {
        // Call setupRestartTimer on serverManager
        (serverManager as any).setupRestartTimer(mockServerState);

        // Verify setTimeout was NOT called
        expect(setTimeoutSpy).not.toHaveBeenCalled();
      } finally {
        setTimeoutSpy.mockRestore();
        client.dispose();
      }
    });

    it('should clear restart timer when disposing client', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      const mockTimer = setTimeout(() => {}, 1000);
      let exitListener: (() => void) | undefined;
      const mockServerState = {
        process: {
          exitCode: null,
          signalCode: null,
          kill: jest.fn(),
          once: jest.fn((event: string, listener: () => void) => {
            if (event === 'exit') {
              exitListener = listener;
            }
          }),
        },
        restartTimer: mockTimer,
        transport: {
          sendRequest: jest.fn(() => Promise.resolve(null)),
          sendNotification: jest.fn(() => {
            exitListener?.();
          }),
        },
      };

      // Mock servers map to include our test server state
      const serversMap = serverManager.getRunningServers();
      serversMap.set('test-key', mockServerState);

      const clearTimeoutSpy = spyOn(global, 'clearTimeout');

      await client.dispose();

      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimer);
      expect(mockServerState.transport.sendRequest).toHaveBeenCalledWith('shutdown', null, 1000);
      expect(mockServerState.transport.sendNotification).toHaveBeenCalledWith('exit', null);
      expect(mockServerState.process.kill).not.toHaveBeenCalled();

      clearTimeoutSpy.mockRestore();
    });
  });

  describe('restartServers', () => {
    it('should handle restart request for non-existent extensions', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const result = await client.restartServers(['xyz']);

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.message).toContain('No LSP servers found for extensions');
    });

    it('should handle restart request when no servers are running', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const result = await client.restartServers();

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(0);
      expect(result.failed).toHaveLength(0);
      expect(result.message).toBe('No LSP servers are currently running');
    });

    it('should restart servers for specific extensions', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      // Mock servers map with running servers
      const mockServerState = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const serversMap = serverManager.getRunningServers();
      serversMap.set(JSON.stringify(mockServerState.config), mockServerState);

      // Mock serverManager.getServer to simulate successful restart
      const getServerSpy = spyOn(serverManager, 'getServer').mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        documentManager: createMockDocumentManager(),
        startTime: Date.now(),
        config: mockServerState.config,
      });

      const result = await client.restartServers(['ts']);

      expect(result.success).toBe(true);
      expect(result.restarted).toHaveLength(1);
      expect(result.restarted[0]).toContain('typescript-language-server');
      expect(result.failed).toHaveLength(0);
      expect(mockServerState.process.kill).toHaveBeenCalled();
      expect(getServerSpy).toHaveBeenCalledWith(mockServerState.config);

      getServerSpy.mockRestore();
    });

    it('should restart all servers when no extensions specified', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      // Mock multiple servers
      const mockServer1 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts', 'tsx'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const mockServer2 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['py'],
          command: ['pylsp'],
        },
        restartTimer: undefined,
      };

      const serversMap = serverManager.getRunningServers();
      serversMap.set(JSON.stringify(mockServer1.config), mockServer1);
      serversMap.set(JSON.stringify(mockServer2.config), mockServer2);

      // Mock serverManager.getServer
      const getServerSpy = spyOn(serverManager, 'getServer').mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        documentManager: createMockDocumentManager(),
        startTime: Date.now(),
        config: mockServer1.config,
      });

      const result = await client.restartServers();

      expect(result.success).toBe(true);
      expect(result.restarted).toHaveLength(2);
      expect(result.failed).toHaveLength(0);
      expect(mockServer1.process.kill).toHaveBeenCalled();
      expect(mockServer2.process.kill).toHaveBeenCalled();
      expect(getServerSpy).toHaveBeenCalledTimes(2);

      getServerSpy.mockRestore();
    });

    it('should handle partial restart failures', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      const mockServer1 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: undefined,
      };

      const mockServer2 = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['py'],
          command: ['pylsp'],
        },
        restartTimer: undefined,
      };

      const serversMap = serverManager.getRunningServers();
      serversMap.set(JSON.stringify(mockServer1.config), mockServer1);
      serversMap.set(JSON.stringify(mockServer2.config), mockServer2);

      let callCount = 0;
      const getServerSpy = spyOn(serverManager, 'getServer').mockImplementation(
        async (config: unknown) => {
          callCount++;
          if (callCount === 1) {
            return {
              process: { kill: jest.fn() },
              initialized: true,
              initializationPromise: Promise.resolve(),
              documentManager: createMockDocumentManager(),
              startTime: Date.now(),
              config,
            };
          }
          throw new Error('Failed to start server');
        }
      );

      const result = await client.restartServers();

      expect(result.success).toBe(false);
      expect(result.restarted).toHaveLength(1);
      expect(result.failed).toHaveLength(1);
      expect(result.message).toContain('Restarted 1 server(s), but 1 failed');

      getServerSpy.mockRestore();
    });

    it('should clear restart timer before restarting', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const serverManager = (client as any).serverManager;

      const mockTimer = setTimeout(() => {}, 1000);
      const mockServerState = {
        process: { kill: jest.fn() },
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
        },
        restartTimer: mockTimer,
      };

      const serversMap = serverManager.getRunningServers();
      serversMap.set(JSON.stringify(mockServerState.config), mockServerState);

      const clearTimeoutSpy = spyOn(global, 'clearTimeout');
      const getServerSpy = spyOn(serverManager, 'getServer').mockResolvedValue({
        process: { kill: jest.fn() },
        initialized: true,
        initializationPromise: Promise.resolve(),
        documentManager: createMockDocumentManager(),
        startTime: Date.now(),
        config: mockServerState.config,
      });

      await client.restartServers(['ts']);

      expect(clearTimeoutSpy).toHaveBeenCalledWith(mockTimer);

      clearTimeoutSpy.mockRestore();
      getServerSpy.mockRestore();
    });
  });

  describe('getDiagnostics', () => {
    it('should return diagnostics when server supports textDocument/diagnostic', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockDiagnostics = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1, // Error
          message: 'Test error message',
          source: 'test',
        },
        {
          range: {
            start: { line: 5, character: 2 },
            end: { line: 5, character: 8 },
          },
          severity: 2, // Warning
          message: 'Test warning message',
          source: 'test',
        },
      ];

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue({
          kind: 'full',
          items: mockDiagnostics,
        }),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.getDiagnostics(MOCK_TEST_TS);

      expect(result).toEqual(mockDiagnostics);
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'textDocument/diagnostic',
        {
          textDocument: { uri: pathToUri(MOCK_TEST_TS) },
        },
        expect.any(Number)
      );

      getServerSpy.mockRestore();
    });

    it('rejects unchanged reports without a corresponding previous result id', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue({
          kind: 'unchanged',
          resultId: 'test-result-id',
        }),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      await expect(client.getDiagnostics(MOCK_TEST_TS)).rejects.toThrow(
        'LSP_REQUEST_INVALID_RESPONSE'
      );

      getServerSpy.mockRestore();
    });

    it('does not certify cached push diagnostics as current', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockDiagnostics = [
        {
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 10 },
          },
          severity: 1,
          message: 'Cached error',
        },
      ];

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(
          new Map([[pathToUri(MOCK_TEST_TS), mockDiagnostics]])
        ),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);
      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
      const savedLogLevel = process.env.CCLSP_LOG_LEVEL;
      process.env.CCLSP_LOG_LEVEL = 'debug';

      try {
        await expect(client.getDiagnostics(MOCK_TEST_TS)).rejects.toThrow(
          'LSP_REQUEST_INVALID_RESPONSE'
        );
      } finally {
        if (savedLogLevel !== undefined) {
          process.env.CCLSP_LOG_LEVEL = savedLogLevel;
        } else {
          Reflect.deleteProperty(process.env, 'CCLSP_LOG_LEVEL');
        }
        getServerSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('should handle server not supporting textDocument/diagnostic', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockRejectedValue(new Error('Method not found')),
      });

      const mockServerState = {
        serverCapabilities: {},
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const stderrSpy = spyOn(process.stderr, 'write').mockImplementation(() => true);
      const savedLogLevel = process.env.CCLSP_LOG_LEVEL;
      process.env.CCLSP_LOG_LEVEL = 'debug';

      try {
        await expect(client.getDiagnostics(MOCK_TEST_TS)).rejects.toThrow(
          'LSP_DIAGNOSTICS_UNKNOWN'
        );
        expect(mockTransport.sendRequest).not.toHaveBeenCalled();
      } finally {
        if (savedLogLevel !== undefined) {
          process.env.CCLSP_LOG_LEVEL = savedLogLevel;
        } else {
          Reflect.deleteProperty(process.env, 'CCLSP_LOG_LEVEL');
        }
        getServerSpy.mockRestore();
        stderrSpy.mockRestore();
      }
    });

    it('should handle unexpected response format', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue({ unexpected: 'response' }),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      await expect(client.getDiagnostics(MOCK_TEST_TS)).rejects.toThrow(
        'LSP_REQUEST_INVALID_RESPONSE'
      );

      getServerSpy.mockRestore();
    });
  });

  describe('hover', () => {
    it('should return hover information when available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockHoverResult = {
        contents: 'function test(): void',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 10 },
        },
      };

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockHoverResult),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.hover(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toEqual(mockHoverResult);
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'textDocument/hover',
        {
          textDocument: { uri: pathToUri(MOCK_TEST_TS) },
          position: { line: 0, character: 5 },
        },
        30000
      );

      getServerSpy.mockRestore();
    });

    it('should return null when no hover information available', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(null),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.hover(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toBeNull();

      getServerSpy.mockRestore();
    });
  });

  describe('workspaceSymbol', () => {
    it('should return symbols matching query', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockSymbols = [
        {
          name: 'testFunction',
          kind: 12, // Function
          location: {
            uri: pathToUri(MOCK_TEST_TS),
            range: {
              start: { line: 0, character: 0 },
              end: { line: 0, character: 20 },
            },
          },
        },
        {
          name: 'testClass',
          kind: 5, // Class
          location: {
            uri: pathToUri(MOCK_TEST_TS),
            range: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 15 },
            },
          },
        },
      ];

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockSymbols),
      });
      const mockDocumentManager = createMockDocumentManager();
      const seedPath = join(TEST_DIR, 'seed.ts');
      await writeFile(seedPath, 'export const seed = true;');

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        adapter: undefined,
        documentManager: mockDocumentManager,
        diagnosticsCache: createMockDiagnosticsCache(),
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
          rootDir: TEST_DIR,
        },
      };

      // Mock servers map
      (client as any).serverManager.getRunningServers().set('test-key', mockServerState);

      const result = await client.workspaceSymbol('test');

      expect(result.symbols).toEqual(mockSymbols);
      expect(mockDocumentManager.acquire).toHaveBeenCalledWith(seedPath);
      const seedLease = await mockDocumentManager.acquire.mock.results[0]?.value;
      expect(seedLease?.release).toHaveBeenCalledTimes(
        mockDocumentManager.acquire.mock.calls.length
      );
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'workspace/symbol',
        { query: 'test' },
        30000
      );
    });

    it('answers from a capable server while a sibling that cannot do workspace/symbol is skipped', async () => {
      // Measured through the real Hub: a YAML server sharing the root made EVERY
      // name search fail with its own refusal while the TypeScript answer was
      // available. Unsupported is a fact about that server, never about the symbol.
      const client = new LSPClient(TEST_CONFIG_PATH);
      const seedPath = join(TEST_DIR, 'seed.ts');
      await writeFile(seedPath, 'export const seed = true;');
      const symbols = [
        {
          name: 'testFunction',
          kind: 12,
          location: {
            uri: pathToUri(MOCK_TEST_TS),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          },
        },
      ];
      const capable = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: createMockTransport({ sendRequest: jest.fn().mockResolvedValue(symbols) }),
        initialized: true,
        adapter: undefined,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
          rootDir: TEST_DIR,
        },
      };
      // Refuses exactly as a real yaml-language-server does: the capability is
      // absent, so the request comes back typed as unsupported.
      const incapableTransport = createMockTransport({
        sendRequest: jest.fn().mockRejectedValue(
          new LspToolOutcomeError({
            outcome: 'unsupported',
            code: 'LSP_METHOD_UNSUPPORTED',
            method: 'workspace/symbol',
            server: 'yaml-language-server --stdio',
          })
        ),
      });
      const incapable = {
        ...capable,
        // Advertises the capability and still refuses when asked, which is the
        // shape that actually reached the Hub.
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        transport: incapableTransport,
        documentManager: createMockDocumentManager(),
        config: {
          // Same extensions as the capable server ON PURPOSE: seed files exist for
          // it, so if priming ran it would really open documents. A server whose
          // extensions match nothing in the root would hide that cost.
          extensions: ['ts'],
          command: ['yaml-language-server', '--stdio'],
          rootDir: TEST_DIR,
        },
      };
      (client as any).serverManager.getRunningServers().set('yaml', incapable);
      (client as any).serverManager.getRunningServers().set('ts', capable);

      const result = await client.workspaceSymbol('test');

      expect(result.symbols).toEqual(symbols);
      // Its refusal must neither surface as the answer nor make it look incomplete.
      expect(result.readinessConfirmed).toBe(true);
    });

    it('does not let a surviving unrelated server certify a failed provider', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      await writeFile(join(TEST_DIR, 'seed.ts'), 'export const seed = true;');
      const failed = (client as any).config.servers[0];
      const successful = {
        serverCapabilities: { workspaceSymbolProvider: true },
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
        config: { extensions: ['json'], command: ['json-language-server'], rootDir: TEST_DIR },
      };
      const getServer = spyOn((client as any).serverManager, 'getServer').mockImplementation(
        async (config: unknown) => {
          if (config === failed) throw new Error('TypeScript initialization failed');
          return successful;
        }
      );
      try {
        await client.preloadServers(false);
        (client as any).serverManager.getRunningServers().set('json', successful);
        expect(await client.workspaceSymbol('missingTypeScriptSymbol')).toEqual({
          symbols: [],
          readinessConfirmed: false,
        });
      } finally {
        getServer.mockRestore();
        await rm(join(TEST_DIR, 'seed.ts'), { force: true });
      }
    });

    it('coalesces and scopes failed-provider recovery across a concurrent name batch', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const failedKey = JSON.stringify((client as any).config.servers[0]);
      (client as any).workspaceSymbolUnavailableServers.add(failedKey);
      const serverState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: createMockTransport(),
        initialized: true,
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
        config: { extensions: ['json'], command: ['json-language-server'], rootDir: TEST_DIR },
      };
      (client as any).serverManager.getRunningServers().set('json', serverState);
      const getServer = spyOn((client as any).serverManager, 'getServer').mockImplementation(
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          throw new Error('still unavailable');
        }
      );
      const preload = spyOn(client, 'preloadServers');
      const workspaceSymbolSpy = spyOn(operations, 'workspaceSymbol').mockResolvedValue([]);
      try {
        const results = await Promise.all(
          Array.from({ length: 7 }, (_, index) => client.workspaceSymbol(`name${index}`))
        );
        expect(preload).not.toHaveBeenCalled();
        expect(getServer).toHaveBeenCalledTimes(1);
        expect(results.every((result) => result.readinessConfirmed === false)).toBe(true);
      } finally {
        getServer.mockRestore();
        preload.mockRestore();
        workspaceSymbolSpy.mockRestore();
      }
    });

    it('confirms a workspace-wide index through its adapter and answers once', async () => {
      // intelephense announces the end of its index; that adapter answer is the
      // readiness, and one request covers the workspace. No seed is touched per
      // query and nothing is polled.
      const client = new LSPClient(TEST_CONFIG_PATH);
      const seedPath = join(TEST_DIR, 'seed.ts');
      await writeFile(seedPath, 'export const seedSymbol = true;');
      const waitForProjectReady = jest.fn(async () => true);
      const serverState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: createMockTransport(),
        initialized: true,
        adapter: { waitForProjectReady },
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
        config: { extensions: ['ts'], command: ['intelephense', '--stdio'], rootDir: TEST_DIR },
      };
      (client as any).serverManager.getRunningServers().set('php', serverState);
      const workspaceSymbolSpy = spyOn(operations, 'workspaceSymbol').mockResolvedValue([]);

      try {
        const result = await client.workspaceSymbol('NoSuchSymbolAnywhere');
        expect(result).toEqual({ symbols: [], readinessConfirmed: true });
        expect(waitForProjectReady).toHaveBeenCalledTimes(1);
        expect(workspaceSymbolSpy).toHaveBeenCalledTimes(1);
        // Confirmed once per server: the second name pays one request, no re-check.
        await client.workspaceSymbol('AnotherName');
        expect(waitForProjectReady).toHaveBeenCalledTimes(1);
        expect(workspaceSymbolSpy).toHaveBeenCalledTimes(2);
      } finally {
        workspaceSymbolSpy.mockRestore();
        await rm(seedPath, { force: true });
      }
    });

    /**
     * A fake of the measured typescript-language-server contract: `workspace/symbol`
     * answers only from the project of the document the last request touched.
     * Two seed directories are two projects; `symbolsByProject` says what each
     * declares, and `readyProjects` says which the server confirms as loaded.
     */
    async function scopedWorkspaceServer(
      symbolsByProject: Record<string, string[]>,
      readyProjects: string[] = ['loaded', 'cold']
    ) {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const dirs = ['loaded', 'cold'].map((name) => join(TEST_DIR, name));
      for (const dir of dirs) await mkdir(dir, { recursive: true });
      await writeFile(join(TEST_DIR, 'loaded', 'a.ts'), 'export const loadedSymbol = 1;');
      await writeFile(join(TEST_DIR, 'cold', 'b.ts'), 'export const coldSymbol = 2;');
      const projectOf = (filePath: string) =>
        filePath.includes(`${sep}cold${sep}`) ? 'cold' : 'loaded';
      const readiness: string[] = [];
      const serverState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: createMockTransport(),
        initialized: true,
        adapter: {
          workspaceSymbolScope: (_state: unknown, filePath: string) => projectOf(filePath),
          waitForProjectReady: async (_state: unknown, filePath: string) => {
            readiness.push(projectOf(filePath));
            return readyProjects.includes(projectOf(filePath));
          },
        },
        documentManager: createMockDocumentManager(),
        diagnosticsCache: createMockDiagnosticsCache(),
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
          rootDir: TEST_DIR,
        },
      };
      (client as any).serverManager.getRunningServers().set('ts', serverState);
      let lastTouched = 'loaded';
      const documentSymbolsSpy = spyOn(operations, 'getDocumentSymbols').mockImplementation(
        async (_state: unknown, filePath: string) => {
          lastTouched = projectOf(filePath);
          return [] as never;
        }
      );
      const asked: Array<{ scope: string; query: string }> = [];
      const workspaceSymbolSpy = spyOn(operations, 'workspaceSymbol').mockImplementation(
        async (_state: unknown, query: string) => {
          asked.push({ scope: lastTouched, query });
          const names = symbolsByProject[lastTouched] ?? [];
          return names
            .filter((name) => name.toLowerCase().includes(query.toLowerCase()))
            .map((name) => ({
              name,
              kind: 13,
              location: {
                uri: pathToUri(
                  join(TEST_DIR, lastTouched, lastTouched === 'cold' ? 'b.ts' : 'a.ts')
                ),
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 10 } },
              },
            })) as never;
        }
      );
      const cleanup = async () => {
        documentSymbolsSpy.mockRestore();
        workspaceSymbolSpy.mockRestore();
        for (const dir of dirs) await rm(dir, { recursive: true, force: true });
      };
      return { client, asked, readiness, cleanup };
    }

    it('asks a last-document-scoped server once per project scope and merges', async () => {
      // The measured false zero: tsls scopes navto to the last touched file's
      // project, so a symbol in a sibling project answered nothing. Steering the
      // scope through one seed per project makes the answer cover the workspace.
      const { client, asked, readiness, cleanup } = await scopedWorkspaceServer({
        loaded: ['loadedSymbol', 'sharedName'],
        cold: ['coldSymbol', 'sharedName', 'onlyInCold'],
      });
      try {
        const result = await client.workspaceSymbol('onlyInCold');
        expect(result.readinessConfirmed).toBe(true);
        expect(result.symbols.map((symbol) => symbol.name)).toEqual(['onlyInCold']);
        // Exactly one request per scope, each after its own touch and readiness.
        expect(asked.map((row) => `${row.scope}:${row.query}`).sort()).toEqual([
          'cold:onlyInCold',
          'loaded:onlyInCold',
        ]);
        expect(new Set(readiness)).toEqual(new Set(['loaded', 'cold']));
        // A name both projects declare yields one row per declaration, none twice.
        const shared = await client.workspaceSymbol('sharedName');
        expect(shared.symbols.map((symbol) => symbol.location.uri)).toHaveLength(2);
        expect(new Set(shared.symbols.map((symbol) => symbol.location.uri)).size).toBe(2);
      } finally {
        await cleanup();
      }
    });

    it('reports a last-document-scoped answer unconfirmed while any project scope is not ready', async () => {
      // One loaded program says nothing about a sibling still loading: rows from
      // the loaded scope are returned, but the answer is not called complete.
      const { client, cleanup } = await scopedWorkspaceServer(
        { loaded: ['loadedSymbol'], cold: ['coldSymbol'] },
        ['loaded']
      );
      try {
        const result = await client.workspaceSymbol('Symbol');
        expect(result.readinessConfirmed).toBe(false);
        expect(result.symbols.map((symbol) => symbol.name).sort()).toEqual([
          'coldSymbol',
          'loadedSymbol',
        ]);
      } finally {
        await cleanup();
      }
    });

    it('serializes concurrent names on a scoped server so touches never interleave', async () => {
      const { client, asked, cleanup } = await scopedWorkspaceServer({
        loaded: ['alphaOne'],
        cold: ['betaTwo'],
      });
      try {
        const [alpha, beta] = await Promise.all([
          client.workspaceSymbol('alphaOne'),
          client.workspaceSymbol('betaTwo'),
        ]);
        expect(alpha.symbols.map((symbol) => symbol.name)).toEqual(['alphaOne']);
        expect(beta.symbols.map((symbol) => symbol.name)).toEqual(['betaTwo']);
        // Each query saw both scopes, and no scope was asked the wrong name mid-touch.
        for (const query of ['alphaOne', 'betaTwo']) {
          expect(
            asked
              .filter((row) => row.query === query)
              .map((row) => row.scope)
              .sort()
          ).toEqual(['cold', 'loaded']);
        }
      } finally {
        await cleanup();
      }
    });

    it('never primes a server that cannot answer workspace/symbol', async () => {
      // Priming opens seed documents and waits for the project to warm. Doing that
      // for a server that is going to refuse the query spends the expensive half of
      // the call for nothing, and the refusal arrives afterwards either way.
      const client = new LSPClient(TEST_CONFIG_PATH);
      const seedPath = join(TEST_DIR, 'seed.ts');
      await writeFile(seedPath, 'export const seed = true;');
      const symbols = [
        {
          name: 'testFunction',
          kind: 12,
          location: {
            uri: pathToUri(MOCK_TEST_TS),
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
          },
        },
      ];
      const base = {
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        initialized: true,
        adapter: undefined,
        diagnosticsCache: createMockDiagnosticsCache(),
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
          rootDir: TEST_DIR,
        },
      };
      const capable = {
        ...base,
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        transport: createMockTransport({ sendRequest: jest.fn().mockResolvedValue(symbols) }),
        documentManager: createMockDocumentManager(),
      };
      const unsupportedTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue([]),
      });
      const unsupportedDocuments = createMockDocumentManager();
      const unsupported = {
        ...base,
        // The capability is simply absent, as it is on a YAML or JSON server.
        serverCapabilities: { documentSymbolProvider: true },
        transport: unsupportedTransport,
        documentManager: unsupportedDocuments,
      };
      (client as any).serverManager.getRunningServers().set('unsupported', unsupported);
      (client as any).serverManager.getRunningServers().set('ts', capable);

      const result = await client.workspaceSymbol('test');

      expect(result.symbols).toEqual(symbols);
      // Untouched: no seed document opened, no request sent, and its silence does
      // not make the answer look incomplete.
      expect(unsupportedDocuments.acquire).not.toHaveBeenCalled();
      expect(unsupportedTransport.sendRequest).not.toHaveBeenCalled();
      expect(result.readinessConfirmed).toBe(true);
      // The capable sibling was primed and asked, so the skip is selective.
      expect(capable.documentManager.acquire).toHaveBeenCalledWith(seedPath);
    });

    it('should return empty array when no servers running', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const preloadSpy = spyOn(client, 'preloadServers').mockResolvedValue();

      // serverManager starts with an empty servers map by default
      const result = await client.workspaceSymbol('test');

      expect(result.symbols).toEqual([]);
      // No server could be shown searchable, so zero rows is not an assertion of
      // absence.
      expect(result.readinessConfirmed).toBe(false);
      expect(preloadSpy).toHaveBeenCalledWith(false);

      preloadSpy.mockRestore();
    });

    it('should return empty array when result is not an array', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(null),
      });
      const mockDocumentManager = createMockDocumentManager();
      const seedPath = join(TEST_DIR, 'seed.ts');
      await writeFile(seedPath, 'export const seed = true;');

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        adapter: undefined,
        documentManager: mockDocumentManager,
        diagnosticsCache: createMockDiagnosticsCache(),
        config: {
          extensions: ['ts'],
          command: ['typescript-language-server', '--stdio'],
          rootDir: TEST_DIR,
        },
      };

      (client as any).serverManager.getRunningServers().set('test-key', mockServerState);

      const result = await client.workspaceSymbol('test');

      expect(result.symbols).toEqual([]);
      expect(mockDocumentManager.acquire).toHaveBeenCalledWith(seedPath);
      const seedLease = await mockDocumentManager.acquire.mock.results[0]?.value;
      expect(seedLease?.release).toHaveBeenCalledTimes(
        mockDocumentManager.acquire.mock.calls.length
      );
    });
  });

  describe('findImplementation', () => {
    it('should return array of implementation locations', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocations = [
        {
          uri: pathToUri(MOCK_IMPL1_TS),
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 20 },
          },
        },
        {
          uri: pathToUri(MOCK_IMPL2_TS),
          range: {
            start: { line: 10, character: 0 },
            end: { line: 10, character: 25 },
          },
        },
      ];

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockLocations),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.findImplementation(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toEqual(mockLocations);
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'textDocument/implementation',
        {
          textDocument: { uri: pathToUri(MOCK_TEST_TS) },
          position: { line: 0, character: 5 },
        },
        30000
      );

      getServerSpy.mockRestore();
    });

    it('should return single location when result is object', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockLocation = {
        uri: pathToUri(MOCK_IMPL_TS),
        range: {
          start: { line: 5, character: 0 },
          end: { line: 5, character: 20 },
        },
      };

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockLocation),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.findImplementation(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toEqual([mockLocation]);

      getServerSpy.mockRestore();
    });

    it('should return empty array when no implementations found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(null),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.findImplementation(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
    });
  });

  describe('prepareCallHierarchy', () => {
    it('should return call hierarchy items', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItems = [
        {
          name: 'testFunction',
          kind: 12, // Function
          uri: pathToUri(MOCK_TEST_TS),
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 20 },
          },
          selectionRange: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 12 },
          },
        },
      ];

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockItems),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.prepareCallHierarchy(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toEqual(mockItems);
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'textDocument/prepareCallHierarchy',
        {
          textDocument: { uri: pathToUri(MOCK_TEST_TS) },
          position: { line: 0, character: 5 },
        },
        30000
      );

      getServerSpy.mockRestore();
    });

    it('should return empty array when no items found', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(null),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        documentManager: createMockDocumentManager(),
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.prepareCallHierarchy(MOCK_TEST_TS, {
        line: 0,
        character: 5,
      });

      expect(result).toEqual([]);

      getServerSpy.mockRestore();
    });
  });

  describe('incomingCalls', () => {
    it('should return incoming calls using uriToPath', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12, // Function
        uri: pathToUri(MOCK_TEST_TS),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockIncomingCalls = [
        {
          from: {
            name: 'caller1',
            kind: 12,
            uri: pathToUri(MOCK_CALLER1_TS),
            range: {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
            selectionRange: {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 7 },
            },
          },
          fromRanges: [
            {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
          ],
        },
      ];

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockIncomingCalls),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.incomingCalls(mockItem);

      expect(result).toEqual(mockIncomingCalls);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'callHierarchy/incomingCalls',
        { item: mockItem },
        30000
      );

      getServerSpy.mockRestore();
    });

    it('should return empty array when no incoming calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: pathToUri(MOCK_TEST_TS),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(null),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.incomingCalls(mockItem);

      expect(result).toEqual([]);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));

      getServerSpy.mockRestore();
    });
  });

  describe('strict rewrite synchronization', () => {
    it('takes one writer scope, syncs an open document, and clears diagnostics', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const documentManager = createMockDocumentManager();
      const diagnosticsCache = createMockDiagnosticsCache();
      const release = jest.fn();
      documentManager.isOpen.mockReturnValue(true);
      documentManager.withWriter.mockImplementation(async (action) => {
        try {
          return await action({ epoch: 0 });
        } finally {
          release();
        }
      });
      const serverState = {
        initializationPromise: Promise.resolve(),
        documentManager,
        diagnosticsCache,
      };
      const getServerSpy = spyOn(
        (
          client as unknown as {
            serverManager: { getServer: (config: unknown) => Promise<unknown> };
          }
        ).serverManager,
        'getServer'
      ).mockResolvedValue(serverState);

      await client.synchronizeRewriteFilesStrict([
        { path: MOCK_TEST_TS, content: 'const x = 2;\n' },
      ]);

      expect(documentManager.withWriter).toHaveBeenCalledTimes(1);
      expect(documentManager.acquire).not.toHaveBeenCalled();
      expect(documentManager.sendChange).toHaveBeenCalledTimes(1);
      expect(documentManager.sendChange).toHaveBeenCalledWith(MOCK_TEST_TS, 'const x = 2;\n');
      expect(documentManager.setSyncSig).toHaveBeenCalledWith(
        MOCK_TEST_TS,
        operations.contentSignature('const x = 2;\n')
      );
      expect(diagnosticsCache.delete).toHaveBeenCalledWith(pathToUri(MOCK_TEST_TS));
      expect(release).toHaveBeenCalledTimes(1);
      getServerSpy.mockRestore();
    });

    it('groups files by server while sending one change per configured document', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const documentManager = createMockDocumentManager();
      documentManager.isOpen.mockReturnValue(true);
      const getServerSpy = spyOn(
        (
          client as unknown as {
            serverManager: { getServer: (config: unknown) => Promise<unknown> };
          }
        ).serverManager,
        'getServer'
      ).mockResolvedValue({
        initializationPromise: Promise.resolve(),
        documentManager,
        diagnosticsCache: createMockDiagnosticsCache(),
      });

      await client.synchronizeRewriteFilesStrict([
        { path: MOCK_TEST_TS, content: 'const x = 1;\n' },
        { path: MOCK_IMPL_TS, content: 'const y = 2;\n' },
      ]);

      expect(getServerSpy).toHaveBeenCalledTimes(1);
      expect(documentManager.sendChange).toHaveBeenCalledTimes(2);
      getServerSpy.mockRestore();
    });

    it('propagates document synchronization failures and always releases the lease', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);
      const documentManager = createMockDocumentManager();
      const release = jest.fn();
      documentManager.isOpen.mockReturnValue(true);
      documentManager.withWriter.mockImplementation(async (action) => {
        try {
          return await action({ epoch: 0 });
        } finally {
          release();
        }
      });
      documentManager.sendChange.mockImplementation(() => {
        throw new Error('didChange failed');
      });
      const getServerSpy = spyOn(
        (
          client as unknown as {
            serverManager: { getServer: (config: unknown) => Promise<unknown> };
          }
        ).serverManager,
        'getServer'
      ).mockResolvedValue({
        initializationPromise: Promise.resolve(),
        documentManager,
        diagnosticsCache: createMockDiagnosticsCache(),
      });

      await expect(
        client.synchronizeRewriteFilesStrict([{ path: MOCK_TEST_TS, content: 'const x = 2;\n' }])
      ).rejects.toThrow('didChange failed');
      expect(release).toHaveBeenCalledTimes(1);
      getServerSpy.mockRestore();
    });
  });

  describe('outgoingCalls', () => {
    it('should return outgoing calls using uriToPath', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12, // Function
        uri: pathToUri(MOCK_TEST_TS),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockOutgoingCalls = [
        {
          to: {
            name: 'callee1',
            kind: 12,
            uri: pathToUri(MOCK_CALLEE1_TS),
            range: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 15 },
            },
            selectionRange: {
              start: { line: 10, character: 0 },
              end: { line: 10, character: 7 },
            },
          },
          fromRanges: [
            {
              start: { line: 5, character: 0 },
              end: { line: 5, character: 10 },
            },
          ],
        },
      ];

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(mockOutgoingCalls),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.outgoingCalls(mockItem);

      expect(result).toEqual(mockOutgoingCalls);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));
      expect(mockTransport.sendRequest).toHaveBeenCalledWith(
        'callHierarchy/outgoingCalls',
        { item: mockItem },
        30000
      );

      getServerSpy.mockRestore();
    });

    it('should return empty array when no outgoing calls', async () => {
      const client = new LSPClient(TEST_CONFIG_PATH);

      const mockItem = {
        name: 'testFunction',
        kind: 12,
        uri: pathToUri(MOCK_TEST_TS),
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 20 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 12 },
        },
      };

      const mockTransport = createMockTransport({
        sendRequest: jest.fn().mockResolvedValue(null),
      });

      const mockServerState = {
        serverCapabilities: MOCK_SERVER_CAPABILITIES,
        initializationPromise: Promise.resolve(),
        process: { stdin: { write: jest.fn() } },
        transport: mockTransport,
        initialized: true,
        adapter: undefined,
      };

      const getServerSpy = spyOn(
        client as unknown as LSPClientInternal,
        'getServer'
      ).mockResolvedValue(mockServerState);

      const result = await client.outgoingCalls(mockItem);

      expect(result).toEqual([]);
      expect(getServerSpy).toHaveBeenCalledWith(uriToPath(mockItem.uri));

      getServerSpy.mockRestore();
    });
  });
});
