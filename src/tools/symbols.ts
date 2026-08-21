import type { DocumentSymbol, SymbolInformation } from '../lsp/types.js';
import { uriToPath } from '../utils.js';
import { resolvePath, rethrowToolOutcome, textResult } from './helpers.js';
import {
  positionResolutionResult,
  resolveToolPosition,
  resolvedFromMetadata,
  resolvedFromText,
} from './position-resolver.js';
import type { ToolDefinition } from './registry.js';

interface DocumentSymbolOutput {
  name: string;
  kind: string;
  range: DocumentSymbol['range'];
  selectionRange: DocumentSymbol['selectionRange'];
  container?: string;
  detail?: string;
  children: DocumentSymbolOutput[];
}

function mapHierarchicalSymbol(
  symbol: DocumentSymbol,
  client: Parameters<ToolDefinition['handler']>[1],
  container?: string
): DocumentSymbolOutput {
  return {
    name: symbol.name,
    kind: client.symbolKindToString(symbol.kind),
    range: symbol.range,
    selectionRange: symbol.selectionRange,
    ...(container ? { container } : {}),
    ...(symbol.detail ? { detail: symbol.detail } : {}),
    children: (symbol.children ?? []).map((child) =>
      mapHierarchicalSymbol(child, client, symbol.name)
    ),
  };
}

function mapFlatSymbol(
  symbol: SymbolInformation,
  client: Parameters<ToolDefinition['handler']>[1]
): DocumentSymbolOutput {
  return {
    name: symbol.name,
    kind: client.symbolKindToString(symbol.kind),
    range: symbol.location.range,
    selectionRange: symbol.location.range,
    ...(symbol.containerName ? { container: symbol.containerName } : {}),
    children: [],
  };
}

export const getDocumentSymbolsTool: ToolDefinition = {
  name: 'get_document_symbols',
  description:
    'Enumerate declarations in one file. Returns each symbol name, kind, full range, selection range, container, and children.',
  inputSchema: {
    type: 'object',
    properties: { file_path: { type: 'string', description: 'The path to the file to enumerate' } },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path } = args as { file_path: string };
    const absolutePath = resolvePath(file_path);
    try {
      const symbols = await client.getDocumentSymbols(absolutePath);
      const hierarchical =
        symbols.length === 0 ||
        ('range' in (symbols[0] as DocumentSymbol) &&
          'selectionRange' in (symbols[0] as DocumentSymbol));
      const output = hierarchical
        ? (symbols as DocumentSymbol[]).map((symbol) => mapHierarchicalSymbol(symbol, client))
        : (symbols as SymbolInformation[]).map((symbol) => mapFlatSymbol(symbol, client));
      return {
        content: [
          {
            type: 'text',
            text:
              output.length === 0
                ? `No document symbols found in ${file_path}`
                : `Document symbols in ${file_path}:\n${JSON.stringify(output, null, 2)}`,
          },
        ],
        structuredContent: { outcome: 'ok', file: absolutePath, symbols: output },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const findWorkspaceSymbolsTool: ToolDefinition = {
  name: 'find_workspace_symbols',
  description: 'Search for symbols across the entire workspace by name.',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'The symbol name or pattern' } },
    required: ['query'],
  },
  handler: async (args, client) => {
    const { query } = args as { query: string };
    try {
      const symbols = await client.workspaceSymbol(query);
      if (symbols.length === 0) return textResult(`No symbols found matching "${query}"`);
      return textResult(
        `Found ${symbols.length} symbol(s) matching "${query}":\n\n${symbols
          .map((symbol) => {
            const start = symbol.location.range.start;
            return `• ${symbol.name} (${client.symbolKindToString(symbol.kind)}) at ${uriToPath(symbol.location.uri)}:${start.line + 1}:${start.character + 1}`;
          })
          .join('\n')}`
      );
    } catch (error) {
      rethrowToolOutcome(error);
      return textResult(
        `Error searching symbols: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

const positionSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'The path to the file' },
    query: { type: 'string', description: 'Symbol query (alternative to line/character)' },
    line: { type: 'number', description: 'The line number (1-indexed)' },
    character: { type: 'number', description: 'The character position (1-indexed)' },
  },
  required: ['file_path'],
};

type PositionArgs = {
  file_path: string;
  query?: string;
  line?: number;
  character?: number;
};

export const prepareCallHierarchyTool: ToolDefinition = {
  name: 'prepare_call_hierarchy',
  description: 'Get call hierarchy items by symbol query or 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    const { file_path, query, line, character } = args as PositionArgs;
    const absolutePath = resolvePath(file_path);
    try {
      const resolution = await resolveToolPosition(
        absolutePath,
        { query, line, character },
        client
      );
      if (resolution.outcome !== 'resolved') {
        return positionResolutionResult(resolution, file_path);
      }
      const items = await client.prepareCallHierarchy(absolutePath, resolution.position);
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      if (items.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}No call hierarchy item found at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            items: [],
          },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `${resolved ? `${resolved}\n\n` : ''}Call hierarchy item(s):\n\n${items
              .map((item) => {
                const start = item.selectionRange.start;
                return `• ${item.name} (${client.symbolKindToString(item.kind)}) at ${uriToPath(item.uri)}:${start.line + 1}:${start.character + 1}${item.detail ? ` - ${item.detail}` : ''}`;
              })
              .join('\n')}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          items,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      return textResult(
        `Error preparing call hierarchy: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

async function callHierarchyResult(
  direction: 'incoming' | 'outgoing',
  args: PositionArgs,
  client: Parameters<ToolDefinition['handler']>[1]
) {
  const absolutePath = resolvePath(args.file_path);
  const resolution = await resolveToolPosition(
    absolutePath,
    { query: args.query, line: args.line, character: args.character },
    client
  );
  if (resolution.outcome !== 'resolved') {
    return positionResolutionResult(resolution, args.file_path);
  }
  const items = await client.prepareCallHierarchy(absolutePath, resolution.position);
  const resolved = resolvedFromText(resolution);
  const resolvedFrom = resolvedFromMetadata(resolution);
  if (items.length === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${resolved ? `${resolved}\n\n` : ''}No call hierarchy item found at ${args.file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}`,
        },
      ],
      structuredContent: {
        outcome: 'ok',
        ...(resolvedFrom ? { resolvedFrom } : {}),
        calls: [],
      },
    };
  }
  const lines: string[] = [];
  for (const item of items) {
    if (direction === 'incoming') {
      for (const call of await client.incomingCalls(item)) {
        const start = call.from.selectionRange.start;
        lines.push(
          `• ${call.from.name} (${client.symbolKindToString(call.from.kind)}) at ${uriToPath(call.from.uri)}:${start.line + 1}:${start.character + 1}`
        );
      }
    } else {
      for (const call of await client.outgoingCalls(item)) {
        const start = call.to.selectionRange.start;
        lines.push(
          `• ${call.to.name} (${client.symbolKindToString(call.to.kind)}) at ${uriToPath(call.to.uri)}:${start.line + 1}:${start.character + 1}`
        );
      }
    }
  }
  return {
    content: [
      {
        type: 'text' as const,
        text:
          lines.length === 0
            ? `${resolved ? `${resolved}\n\n` : ''}No ${direction} calls found`
            : `${resolved ? `${resolved}\n\n` : ''}Found ${lines.length} ${direction} call(s):\n\n${lines.join('\n')}`,
      },
    ],
    structuredContent: {
      outcome: 'ok',
      ...(resolvedFrom ? { resolvedFrom } : {}),
      calls: lines,
    },
  };
}

export const getIncomingCallsTool: ToolDefinition = {
  name: 'get_incoming_calls',
  description: 'Find incoming calls by symbol query or 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    try {
      return await callHierarchyResult('incoming', args as PositionArgs, client);
    } catch (error) {
      rethrowToolOutcome(error);
      return textResult(
        `Error finding incoming calls: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const getOutgoingCallsTool: ToolDefinition = {
  name: 'get_outgoing_calls',
  description: 'Find outgoing calls by symbol query or 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    try {
      return await callHierarchyResult('outgoing', args as PositionArgs, client);
    } catch (error) {
      rethrowToolOutcome(error);
      return textResult(
        `Error finding outgoing calls: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const symbolTools: ToolDefinition[] = [
  getDocumentSymbolsTool,
  findWorkspaceSymbolsTool,
  prepareCallHierarchyTool,
  getIncomingCallsTool,
  getOutgoingCallsTool,
];
