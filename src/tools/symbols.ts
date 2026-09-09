import type { DocumentSymbol, SymbolInformation } from '../lsp/types.js';
import { uriToPath } from '../utils.js';
import {
  INLINE_RESULT_BYTES,
  SEMANTIC_DEFAULT_LIMIT,
  SEMANTIC_MAX_LIMIT,
  boundedResultLimit,
  resolvePath,
  rethrowToolOutcome,
  spoolFullResult,
} from './helpers.js';
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

const DOCUMENT_SYMBOLS_DEFAULT_LIMIT = SEMANTIC_DEFAULT_LIMIT;
const DOCUMENT_SYMBOLS_MAX_LIMIT = SEMANTIC_MAX_LIMIT;

function flattenDocumentSymbols(symbols: DocumentSymbolOutput[]): DocumentSymbolOutput[] {
  const rows: DocumentSymbolOutput[] = [];
  const visit = (symbol: DocumentSymbolOutput) => {
    rows.push({ ...symbol, children: [] });
    for (const child of symbol.children) visit(child);
  };
  for (const symbol of symbols) visit(symbol);
  return rows;
}

function renderDocumentSymbol(symbol: DocumentSymbolOutput): string {
  const { start, end } = symbol.range;
  const container = symbol.container ? ` · ${symbol.container}` : '';
  const detail = symbol.detail ? ` · ${symbol.detail}` : '';
  return `L${start.line + 1}:C${start.character + 1}-L${end.line + 1}:C${end.character + 1} · ${symbol.kind} · ${symbol.name}${container}${detail}`;
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
    properties: {
      file_path: { type: 'string', description: 'The path to the file to enumerate' },
      max_results: {
        type: 'number',
        description: 'Optional positive row limit; omit for all declarations.',
      },
      include_raw: {
        type: 'boolean',
        description: 'Include bounded selected native symbol rows for explicit diagnostics',
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, max_results, include_raw } = args as {
      file_path: string;
      max_results?: number;
      include_raw?: boolean;
    };
    const absolutePath = resolvePath(file_path);
    try {
      const result = await client.getDocumentSymbolsWithProvider(absolutePath);
      if (result.outcome !== 'ok') {
        return {
          content: [{ type: 'text', text: `${result.code}: ${result.reason}` }],
          structuredContent: result,
          isError: true,
        };
      }
      const symbols = result.value;
      const hierarchical =
        symbols.length === 0 ||
        ('range' in (symbols[0] as DocumentSymbol) &&
          'selectionRange' in (symbols[0] as DocumentSymbol));
      const hierarchy = hierarchical
        ? (symbols as DocumentSymbol[]).map((symbol) => mapHierarchicalSymbol(symbol, client))
        : (symbols as SymbolInformation[]).map((symbol) => mapFlatSymbol(symbol, client));
      if (max_results !== undefined && (!Number.isSafeInteger(max_results) || max_results < 1)) {
        throw new Error('max_results must be a positive safe integer');
      }
      const limit = max_results ?? Number.POSITIVE_INFINITY;
      const rows = flattenDocumentSymbols(hierarchy);
      const selected =
        Buffer.byteLength(JSON.stringify(rows), 'utf8') > INLINE_RESULT_BYTES
          ? []
          : rows.slice(0, limit);
      const omitted = rows.length - selected.length;
      const resultFile =
        omitted > 0
          ? spoolFullResult('get_document_symbols', {
              file: absolutePath,
              provider: result.provider,
              total: rows.length,
              symbols: rows,
            })
          : null;
      if (omitted > 0 && !resultFile) {
        return {
          content: [
            {
              type: 'text',
              text: 'SYMBOL_RESULT_SPOOL_FAILED: complete declarations could not be stored; restore writable result storage and retry.',
            },
          ],
          structuredContent: {
            outcome: 'unavailable',
            provider: result.provider,
            code: 'SYMBOL_RESULT_SPOOL_FAILED',
            file: absolutePath,
          },
          isError: true,
        };
      }
      const recovery = omitted > 0 ? `Read the complete result at ${resultFile}.` : null;
      const text =
        selected.length === 0
          ? `Document symbols (0/0) in ${file_path} · provider ${result.provider}`
          : [
              `Document symbols (${selected.length}/${rows.length}) in ${file_path} · provider ${result.provider}`,
              ...selected.map(renderDocumentSymbol),
              ...(omitted > 0
                ? [
                    `... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`,
                  ]
                : []),
            ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          outcome: rows.length > 0 ? 'ok' : 'empty',
          provider: result.provider,
          file: absolutePath,
          symbols: selected,
          shown: selected.length,
          total: rows.length,
          omitted,
          recovery,
          ...(resultFile ? { resultFile } : {}),
          ...(include_raw ? { rawSymbols: selected } : {}),
          ...(result.provider === 'tree-sitter' ? { limitations: result.limitations } : {}),
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

/**
 * A language server answers `workspace/symbol` from the files it has LOADED, not
 * from the repository: measured on typescript-language-server 5.3.0, a symbol in
 * an unopened file returns nothing, and the identical query returns it once that
 * file is opened. So zero rows here is never evidence that a symbol does not
 * exist, and the caller has to be told which tool can actually answer that.
 */
const NO_MATCH_RECOVERY =
  'Not absence: only loaded files were searched. Repository-wide: ast_search. Or open the file with get_document_symbols, then repeat.';

export const findWorkspaceSymbolsTool: ToolDefinition = {
  name: 'find_workspace_symbols',
  description:
    'Search symbols among the files the language server has LOADED, with bounded rows and totals. Not a repository-wide search: use ast_search for that.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'The symbol name or pattern' },
      max_results: {
        type: 'number',
        description: `Rows to return (default ${DOCUMENT_SYMBOLS_DEFAULT_LIMIT}, max ${DOCUMENT_SYMBOLS_MAX_LIMIT})`,
      },
    },
    required: ['query'],
  },
  handler: async (args, client) => {
    const { query, max_results } = args as { query: string; max_results?: number };
    try {
      const { symbols, readinessConfirmed } = await client.workspaceSymbol(query);
      const selected = symbols.slice(0, boundedResultLimit(max_results));
      const omitted = symbols.length - selected.length;
      const resultFile =
        omitted > 0
          ? spoolFullResult('find_workspace_symbols', { query, total: symbols.length, symbols })
          : null;
      const text =
        selected.length === 0
          ? `Workspace symbols (0/0) matching "${query}" · searched LOADED files only`
          : [
              `Workspace symbols (${selected.length}/${symbols.length}) matching "${query}" · provider lsp`,
              ...selected.map((symbol) => {
                const start = symbol.location.range.start;
                return `${uriToPath(symbol.location.uri)}:${start.line + 1}:${start.character + 1} · ${client.symbolKindToString(symbol.kind)} · ${symbol.name}`;
              }),
              ...(omitted > 0
                ? [
                    `... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`,
                  ]
                : []),
            ].join('\n');
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          // `empty` is a SCOPED negative: no match among the files this provider
          // has loaded. It never asserts the symbol is absent from the repository,
          // because this provider answers only from loaded documents -- an
          // existing symbol in an unopened file returns zero here. Repository-wide
          // absence belongs to the structural tier, which needs no language server.
          // Before the provider is answering at all, zero rows is `stale` instead.
          outcome: selected.length > 0 ? 'ok' : readinessConfirmed ? 'empty' : 'stale',
          readinessConfirmed,
          provider: 'lsp',
          symbols: selected,
          shown: selected.length,
          total: symbols.length,
          omitted,
          recovery:
            omitted > 0
              ? `Read the complete result at ${resultFile ?? '(spool unavailable)'}, or narrow the workspace-symbol query.`
              : selected.length === 0
                ? NO_MATCH_RECOVERY
                : readinessConfirmed
                  ? null
                  : 'The project graph is still loading, so this answer may be incomplete. Retry the same call once it finishes.',
          ...(resultFile ? { resultFile } : {}),
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
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
    max_results: {
      type: 'number',
      description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
    },
  },
  required: ['file_path'],
};

type PositionArgs = {
  file_path: string;
  query?: string;
  line?: number;
  character?: number;
  max_results?: number;
};

export const prepareCallHierarchyTool: ToolDefinition = {
  name: 'prepare_call_hierarchy',
  description: 'Get call hierarchy items by symbol query or 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    const { file_path, query, line, character, max_results } = args as PositionArgs;
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
      const allItems = await client.prepareCallHierarchy(absolutePath, resolution.position);
      const items = allItems.slice(0, boundedResultLimit(max_results));
      const itemsFile =
        allItems.length > items.length
          ? spoolFullResult('prepare_call_hierarchy', {
              file: absolutePath,
              total: allItems.length,
              items: allItems,
            })
          : null;
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
            outcome: 'empty',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            items: [],
            shown: 0,
            total: 0,
            omitted: 0,
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
              .join(
                '\n'
              )}${allItems.length > items.length ? `\n... ${allItems.length - items.length} omitted; complete result: ${itemsFile ?? '(spool unavailable)'}` : ''}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          items,
          shown: items.length,
          total: allItems.length,
          omitted: allItems.length - items.length,
          recovery:
            allItems.length > items.length
              ? `Read the complete result at ${itemsFile ?? '(spool unavailable)'} or narrow the selector.`
              : null,
          ...(itemsFile ? { resultFile: itemsFile } : {}),
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
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
        outcome: 'empty',
        provider: 'lsp',
        ...(resolvedFrom ? { resolvedFrom } : {}),
        calls: [],
        shown: 0,
        total: 0,
        omitted: 0,
      },
    };
  }
  const limit = boundedResultLimit(args.max_results);
  const selectedCalls: unknown[] = [];
  const selectedLines: string[] = [];
  const allCalls: unknown[] = [];
  let total = 0;
  for (const item of items) {
    const itemCalls =
      direction === 'incoming'
        ? await client.incomingCalls(item)
        : await client.outgoingCalls(item);
    for (const call of itemCalls) {
      total += 1;
      allCalls.push(call);
      if (selectedCalls.length >= limit) continue;
      selectedCalls.push(call);
      if (direction === 'incoming' && 'from' in call) {
        const start = call.from.selectionRange.start;
        selectedLines.push(
          `• ${call.from.name} (${client.symbolKindToString(call.from.kind)}) at ${uriToPath(call.from.uri)}:${start.line + 1}:${start.character + 1}`
        );
      } else if (direction === 'outgoing' && 'to' in call) {
        const start = call.to.selectionRange.start;
        selectedLines.push(
          `• ${call.to.name} (${client.symbolKindToString(call.to.kind)}) at ${uriToPath(call.to.uri)}:${start.line + 1}:${start.character + 1}`
        );
      }
    }
  }
  const omitted = total - selectedCalls.length;
  const callsFile =
    omitted > 0
      ? spoolFullResult(`get_${direction}_calls`, {
          file: absolutePath,
          direction,
          total,
          calls: allCalls,
        })
      : null;
  return {
    content: [
      {
        type: 'text' as const,
        text:
          selectedLines.length === 0
            ? `${resolved ? `${resolved}\n\n` : ''}No ${direction} calls found`
            : `${resolved ? `${resolved}\n\n` : ''}Found ${selectedLines.length}/${total} ${direction} call(s):\n\n${selectedLines.join('\n')}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${callsFile ?? '(spool unavailable)'}` : ''}`,
      },
    ],
    structuredContent: {
      outcome: selectedCalls.length > 0 ? 'ok' : 'empty',
      provider: 'lsp',
      ...(resolvedFrom ? { resolvedFrom } : {}),
      calls: selectedCalls,
      shown: selectedCalls.length,
      total,
      omitted,
      recovery:
        omitted > 0
          ? `Read the complete result at ${callsFile ?? '(spool unavailable)'} or narrow the selector.`
          : null,
      ...(callsFile ? { resultFile: callsFile } : {}),
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
      throw error;
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
      throw error;
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
