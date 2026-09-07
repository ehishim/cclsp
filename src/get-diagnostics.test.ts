import { beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { LSPClient } from './lsp-client.js';
import { getDiagnosticsBatchTool, getDiagnosticsTool } from './tools/diagnostics.js';
import type { Diagnostic } from './types.js';

type MockLSPClient = {
  getDiagnostics: ReturnType<typeof jest.fn>;
  getDiagnosticsBatch: ReturnType<typeof jest.fn>;
};

function createMockClient(): MockLSPClient {
  return {
    getDiagnostics: jest.fn(),
    getDiagnosticsBatch: jest.fn(),
  };
}

function callHandler(args: { file_path: string }, mock: MockLSPClient) {
  const client = {
    ...mock,
    getDiagnosticsReport: async (path: string) => ({
      diagnostics: await mock.getDiagnostics(path),
      freshness: { status: 'current' },
    }),
  };
  return getDiagnosticsTool.handler(
    args as Record<string, unknown>,
    client as unknown as LSPClient
  );
}

function callBatchHandler(
  args: { path: string; pattern?: string; max_files?: number },
  mock: MockLSPClient
) {
  return getDiagnosticsBatchTool.handler(
    args as Record<string, unknown>,
    mock as unknown as LSPClient
  );
}

describe('get_diagnostics MCP tool', () => {
  let mockClient: MockLSPClient;

  beforeEach(() => {
    mockClient = createMockClient();
  });

  it('should return message when no diagnostics found', async () => {
    mockClient.getDiagnostics.mockResolvedValue([]);

    const result = await callHandler({ file_path: 'test.ts' }, mockClient);

    expect(result.content[0]?.text).toBe(
      'No diagnostics found for test.ts. The file has no errors, warnings, or hints.'
    );
    expect(mockClient.getDiagnostics).toHaveBeenCalledWith(resolve('test.ts'));
  });

  it('should format single diagnostic correctly', async () => {
    const mockDiagnostics: Diagnostic[] = [
      {
        range: {
          start: { line: 0, character: 5 },
          end: { line: 0, character: 10 },
        },
        severity: 1,
        message: 'Undefined variable',
        code: 'TS2304',
        source: 'typescript',
      },
    ];

    mockClient.getDiagnostics.mockResolvedValue(mockDiagnostics);

    const result = await callHandler({ file_path: 'test.ts' }, mockClient);

    expect(result.content[0]?.text).toContain('Found 1 diagnostic in test.ts:');
    expect(result.content[0]?.text).toContain('Error [TS2304] (typescript): Undefined variable');
    expect(result.content[0]?.text).toContain('Location: Line 1, Column 6 to Line 1, Column 11');
  });

  it('should format multiple diagnostics correctly', async () => {
    const mockDiagnostics: Diagnostic[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
        severity: 1,
        message: 'Missing semicolon',
        code: '1003',
        source: 'typescript',
      },
      {
        range: {
          start: { line: 2, character: 10 },
          end: { line: 2, character: 15 },
        },
        severity: 2,
        message: 'Unused variable',
        source: 'eslint',
      },
      {
        range: {
          start: { line: 5, character: 0 },
          end: { line: 5, character: 20 },
        },
        severity: 3,
        message: 'Consider using const',
      },
      {
        range: {
          start: { line: 10, character: 4 },
          end: { line: 10, character: 8 },
        },
        severity: 4,
        message: 'Add type annotation',
        code: 'no-implicit-any',
      },
    ];

    mockClient.getDiagnostics.mockResolvedValue(mockDiagnostics);

    const result = await callHandler({ file_path: 'src/main.ts' }, mockClient);

    expect(result.content[0]?.text).toContain('Found 4 diagnostics in src/main.ts:');
    expect(result.content[0]?.text).toContain('Error [1003] (typescript): Missing semicolon');
    expect(result.content[0]?.text).toContain('Warning (eslint): Unused variable');
    expect(result.content[0]?.text).toContain('Information: Consider using const');
    expect(result.content[0]?.text).toContain('Hint [no-implicit-any]: Add type annotation');
  });

  it('should handle diagnostics without optional fields', async () => {
    const mockDiagnostics: Diagnostic[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 10 },
        },
        message: 'Basic error message',
      },
    ];

    mockClient.getDiagnostics.mockResolvedValue(mockDiagnostics);

    const result = await callHandler({ file_path: 'test.ts' }, mockClient);

    expect(result.content[0]?.text).toContain('Unknown: Basic error message');
    expect(result.content[0]?.text).not.toContain('[');
    expect(result.content[0]?.text).not.toContain('(');
  });

  it('should handle absolute file paths', async () => {
    mockClient.getDiagnostics.mockResolvedValue([]);

    await callHandler({ file_path: '/absolute/path/to/file.ts' }, mockClient);

    expect(mockClient.getDiagnostics).toHaveBeenCalledWith(resolve('/absolute/path/to/file.ts'));
  });

  it('should handle error from getDiagnostics', async () => {
    mockClient.getDiagnostics.mockRejectedValue(new Error('LSP server not available'));

    const result = await callHandler({ file_path: 'test.ts' }, mockClient);

    expect(result.content[0]?.text).toBe('Error getting diagnostics: LSP server not available');
  });

  it('should handle non-Error exceptions', async () => {
    mockClient.getDiagnostics.mockRejectedValue('Unknown error');

    const result = await callHandler({ file_path: 'test.ts' }, mockClient);

    expect(result.content[0]?.text).toBe('Error getting diagnostics: Unknown error');
  });

  it('should convert 0-indexed line and character to 1-indexed for display', async () => {
    const mockDiagnostics: Diagnostic[] = [
      {
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        severity: 1,
        message: 'Error at start of file',
      },
    ];

    mockClient.getDiagnostics.mockResolvedValue(mockDiagnostics);

    const result = await callHandler({ file_path: 'test.ts' }, mockClient);

    expect(result.content[0]?.text).toContain('Location: Line 1, Column 1 to Line 1, Column 1');
  });

  it('should scan CSS and Markdown extensions while preserving pattern and file bounds', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cclsp-diagnostics-'));
    const admitted = ['styles.css', 'theme.scss', 'mixins.less', 'guide.md', 'notes.markdown'];

    try {
      await Promise.all([
        ...admitted.map((name) => writeFile(join(directory, name), '')),
        writeFile(join(directory, 'ignored.txt'), ''),
      ]);
      mockClient.getDiagnosticsBatch.mockImplementation(async (filePaths: string[]) =>
        filePaths.map((filePath) => ({ filePath, diagnostics: [] }))
      );

      await callBatchHandler({ path: directory }, mockClient);
      const allFiles = mockClient.getDiagnosticsBatch.mock.calls[0]?.[0] as string[];
      expect(allFiles.map((filePath) => filePath.slice(directory.length + 1)).sort()).toEqual(
        admitted.toSorted()
      );

      mockClient.getDiagnosticsBatch.mockClear();
      await callBatchHandler({ path: directory, pattern: '\\.(?:md|markdown)$' }, mockClient);
      const markdownFiles = mockClient.getDiagnosticsBatch.mock.calls[0]?.[0] as string[];
      expect(markdownFiles.map((filePath) => filePath.slice(directory.length + 1)).sort()).toEqual([
        'guide.md',
        'notes.markdown',
      ]);

      mockClient.getDiagnosticsBatch.mockClear();
      await callBatchHandler({ path: directory, max_files: 2 }, mockClient);
      const boundedFiles = mockClient.getDiagnosticsBatch.mock.calls[0]?.[0] as string[];
      expect(boundedFiles).toHaveLength(2);
      expect(
        boundedFiles.every((filePath) => admitted.includes(filePath.slice(directory.length + 1)))
      ).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
