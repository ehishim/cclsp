import { describe, expect, it, jest } from 'bun:test';
import type { LSPClient } from './lsp-client.js';
import { getHoverTool } from './tools/hover.js';
import {
  getCodeActionsTool,
  getCompletionsTool,
  getSignatureHelpTool,
} from './tools/language-features.js';
import { findImplementationTool } from './tools/navigation.js';
import { renameSymbolStrictTool } from './tools/refactoring.js';
import type { ToolDefinition } from './tools/registry.js';
import {
  getIncomingCallsTool,
  getOutgoingCallsTool,
  prepareCallHierarchyTool,
} from './tools/symbols.js';

const POSITION = { line: 3, character: 7 };

function createClient(): LSPClient {
  return {
    getDocumentSymbols: jest.fn().mockResolvedValue([
      {
        name: 'run',
        kind: 6,
        range: { start: POSITION, end: { line: 5, character: 1 } },
        selectionRange: { start: POSITION, end: { line: 3, character: 10 } },
      },
    ]),
    symbolKindToString: jest.fn().mockReturnValue('method'),
    hover: jest.fn().mockResolvedValue(null),
    findImplementation: jest.fn().mockResolvedValue([]),
    getCompletions: jest.fn().mockResolvedValue({
      items: [],
      isIncomplete: false,
      syntheticTrigger: false,
    }),
    resolveCompletionItem: jest.fn((_: string, item: unknown) => Promise.resolve(item)),
    getSignatureHelp: jest.fn().mockResolvedValue(null),
    getCodeActions: jest.fn().mockResolvedValue([]),
    renameSymbol: jest.fn().mockResolvedValue({}),
    prepareCallHierarchy: jest.fn().mockResolvedValue([]),
    incomingCalls: jest.fn().mockResolvedValue([]),
    outgoingCalls: jest.fn().mockResolvedValue([]),
  } as unknown as LSPClient;
}

const cases: Array<{
  name: string;
  tool: ToolDefinition;
  args: Record<string, unknown>;
  method: keyof LSPClient;
}> = [
  { name: 'hover', tool: getHoverTool, args: {}, method: 'hover' },
  {
    name: 'implementation',
    tool: findImplementationTool,
    args: {},
    method: 'findImplementation',
  },
  {
    name: 'completion',
    tool: getCompletionsTool,
    args: { resolve_limit: 0 },
    method: 'getCompletions',
  },
  {
    name: 'signature help',
    tool: getSignatureHelpTool,
    args: {},
    method: 'getSignatureHelp',
  },
  {
    name: 'code actions',
    tool: getCodeActionsTool,
    args: {},
    method: 'getCodeActions',
  },
  {
    name: 'strict rename',
    tool: renameSymbolStrictTool,
    args: { new_name: 'renamed', dry_run: true },
    method: 'renameSymbol',
  },
  {
    name: 'prepare call hierarchy',
    tool: prepareCallHierarchyTool,
    args: {},
    method: 'prepareCallHierarchy',
  },
  {
    name: 'incoming calls',
    tool: getIncomingCallsTool,
    args: {},
    method: 'prepareCallHierarchy',
  },
  {
    name: 'outgoing calls',
    tool: getOutgoingCallsTool,
    args: {},
    method: 'prepareCallHierarchy',
  },
];

describe('query selector parity', () => {
  for (const testCase of cases) {
    it(`resolves ${testCase.name} query to the document-symbol position`, async () => {
      const client = createClient();
      const result = await testCase.tool.handler(
        { file_path: 'example.ts', query: 'run', ...testCase.args },
        client
      );
      const method = client[testCase.method] as unknown as ReturnType<typeof jest.fn>;
      expect(method).toHaveBeenCalled();
      expect(JSON.stringify(method.mock.calls[0])).toContain(JSON.stringify(POSITION));
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        outcome: 'ok',
        resolvedFrom: {
          query: 'run',
          qualifiedName: 'run',
          line: POSITION.line + 1,
          character: POSITION.character + 1,
        },
      });
    });
  }

  it('carries resolved query metadata through strict rename results', async () => {
    const client = createClient();
    const result = await renameSymbolStrictTool.handler(
      { file_path: 'example.ts', query: 'run', new_name: 'renamed', dry_run: true },
      client
    );
    expect(result.structuredContent).toMatchObject({
      outcome: 'ok',
      resolvedFrom: {
        query: 'run',
        qualifiedName: 'run',
        line: POSITION.line + 1,
        character: POSITION.character + 1,
      },
    });
  });

  it('returns ambiguity candidates without issuing the semantic request', async () => {
    const client = createClient();
    (client.getDocumentSymbols as unknown as ReturnType<typeof jest.fn>).mockResolvedValue([
      {
        name: 'run',
        kind: 6,
        range: { start: POSITION, end: POSITION },
        selectionRange: { start: POSITION, end: POSITION },
      },
      {
        name: 'run',
        kind: 6,
        range: { start: { line: 8, character: 2 }, end: { line: 8, character: 5 } },
        selectionRange: {
          start: { line: 8, character: 2 },
          end: { line: 8, character: 5 },
        },
      },
    ]);
    const result = await getHoverTool.handler({ file_path: 'example.ts', query: 'run' }, client);
    expect(result).toMatchObject({
      isError: true,
      structuredContent: { code: 'LSP_SYMBOL_AMBIGUOUS' },
    });
    expect(client.hover).not.toHaveBeenCalled();
  });
});
