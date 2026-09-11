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
import {
  PREVIEW_SCHEMA,
  type PreviewOption,
  type SourcePreview,
  createSourcePreview,
  previewWindow,
  renderLocationRow,
} from './source-preview.js';

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

interface WorkspaceQueryAnswer {
  query: string;
  symbols: SymbolInformation[];
  readinessConfirmed: boolean;
}

/**
 * The protocol takes one string and defines no alternation, so `"a|b"` is matched
 * literally and finds nothing. Several names are therefore several requests whose
 * answers stay SEPARATE: a merged list would hide which name found nothing, which
 * is the false absence the caller asked several names to avoid.
 */
function normalizeWorkspaceQueries(value: unknown): string[] {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) throw new Error('query must name at least one symbol');
  const queries: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error('every query entry must be a non-empty string');
    }
    // Entries are kept exactly as asked, duplicates included. Collapsing them
    // would save one request and silently change the answer: the breakdown would
    // carry fewer rows than the caller listed, and the shared row bound would be
    // spent differently, so a caller comparing its array with the result would
    // find them misaligned with nothing saying why.
    queries.push(entry);
  }
  return queries;
}

function renderWorkspaceRow(
  symbol: SymbolInformation,
  client: Parameters<ToolDefinition['handler']>[1],
  preview: SourcePreview | null
): string {
  const start = symbol.location.range.start;
  return renderLocationRow(preview, {
    file: uriToPath(symbol.location.uri),
    zeroBasedLine: start.line,
    zeroBasedCharacter: start.character,
    suffix: ` · ${client.symbolKindToString(symbol.kind)} · ${symbol.name}`,
  });
}

export const findWorkspaceSymbolsTool: ToolDefinition = {
  name: 'find_workspace_symbols',
  description:
    'Search symbols BY NAME among the files the language server has LOADED, with bounded rows and totals. Pass an array to ask several names in one call; each name reports its own count. Not a repository-wide search: use ast_search for that.',
  inputSchema: {
    type: 'object',
    properties: {
      query: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description:
          'The symbol name or pattern. Pass an array to ask several names in one call; each reports its own count, so a zero among them is attributable. The answer is bounded by max_results, not by a name count. Alternation is never interpreted: express several names as separate entries, not as "a|b".',
      },
      max_results: {
        type: 'number',
        description: `Rows to return across every name (default ${DOCUMENT_SYMBOLS_DEFAULT_LIMIT}, max ${DOCUMENT_SYMBOLS_MAX_LIMIT})`,
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['query'],
  },
  handler: async (args, client) => {
    const { query, max_results, preview } = args as {
      query: unknown;
      max_results?: number;
      preview?: boolean | number;
    };
    try {
      // Both admissions run before any workspace/symbol request: an invalid width
      // or name list must cost nothing, not be refused after the scan is paid for.
      const previewCache = createSourcePreview(preview);
      const queries = normalizeWorkspaceQueries(query);
      const limit = boundedResultLimit(max_results);
      const answers: WorkspaceQueryAnswer[] = await Promise.all(
        queries.map(async (name) => ({ query: name, ...(await client.workspaceSymbol(name)) }))
      );

      // The bound applies to the answer as a whole, and it is spent in the order the
      // caller asked, so a later name is reported as omitted rather than as zero.
      let remaining = limit;
      const perQuery = answers.map((answer) => {
        const selected = answer.symbols.slice(0, Math.max(remaining, 0));
        remaining -= selected.length;
        return {
          query: answer.query,
          symbols: selected,
          shown: selected.length,
          total: answer.symbols.length,
          omitted: answer.symbols.length - selected.length,
          readinessConfirmed: answer.readinessConfirmed,
          // Per name, because the provider answers each request on its own state.
          // The order matters: a name whose rows exist but were cut by the shared
          // row bound is `partial`, NEVER `empty` -- calling that zero would be the
          // false absence this breakdown exists to prevent. Only a name that truly
          // matched nothing is a scoped negative, and only once its provider is
          // confirmed answering; before that it is `stale`.
          outcome:
            selected.length > 0
              ? ('ok' as const)
              : answer.symbols.length > 0
                ? ('partial' as const)
                : answer.readinessConfirmed
                  ? ('empty' as const)
                  : ('stale' as const),
        };
      });

      const selected = perQuery.flatMap((row) => row.symbols);
      const total = answers.reduce((sum, answer) => sum + answer.symbols.length, 0);
      const omitted = total - selected.length;
      const readinessConfirmed = answers.every((answer) => answer.readinessConfirmed);
      // One name keeps the payload it always spooled; several names spool the same
      // breakdown the answer reports, so the complete result stays attributable too.
      const spoolPayload =
        queries.length === 1 && answers[0]
          ? { query: answers[0].query, total, symbols: answers[0].symbols }
          : {
              queries,
              total,
              perQuery: answers.map((answer) => ({
                query: answer.query,
                total: answer.symbols.length,
                symbols: answer.symbols,
              })),
            };
      const resultFile =
        omitted > 0 ? spoolFullResult('find_workspace_symbols', spoolPayload) : null;
      const omittedLine =
        omitted > 0
          ? [`... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`]
          : [];

      const single = queries.length === 1 ? perQuery[0] : null;
      const text = single
        ? single.shown === 0
          ? `Workspace symbols (0/0) matching "${single.query}" · searched LOADED files only`
          : [
              `Workspace symbols (${single.shown}/${single.total}) matching "${single.query}" · provider lsp`,
              ...single.symbols.map((symbol) => renderWorkspaceRow(symbol, client, previewCache)),
              ...omittedLine,
            ].join('\n')
        : [
            `Workspace symbols (${selected.length}/${total}) matching ${queries.length} names · provider lsp · searched LOADED files only`,
            ...perQuery.map(
              (row) =>
                `  "${row.query}": ${row.total} match(es)${row.total === 0 ? ' — no match among LOADED files' : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`
            ),
            ...perQuery
              .filter((row) => row.shown > 0)
              .flatMap((row) => [
                '',
                `"${row.query}"`,
                ...row.symbols.map((symbol) => renderWorkspaceRow(symbol, client, previewCache)),
              ]),
            ...omittedLine,
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
          total,
          omitted,
          // One name keeps the shape it always had; several names always carry the
          // breakdown, because the aggregate alone cannot say which name was zero.
          ...(single ? {} : { queries, perQuery }),
          recovery:
            omitted > 0
              ? `Read the complete result at ${resultFile ?? '(spool unavailable)'}, or narrow the workspace-symbol query.`
              : selected.length === 0
                ? NO_MATCH_RECOVERY
                : perQuery.some((row) => row.total === 0)
                  ? `Some names matched nothing among LOADED files: ${perQuery
                      .filter((row) => row.total === 0)
                      .map((row) => `"${row.query}"`)
                      .join(', ')}. ${NO_MATCH_RECOVERY}`
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
    preview: PREVIEW_SCHEMA,
  },
  required: ['file_path'],
};

type PositionArgs = {
  file_path: string;
  query?: string;
  line?: number;
  character?: number;
  max_results?: number;
  preview?: PreviewOption;
};

export const prepareCallHierarchyTool: ToolDefinition = {
  name: 'prepare_call_hierarchy',
  description: 'Get call hierarchy items by symbol query or 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    const {
      file_path,
      query,
      line,
      character,
      max_results,
      preview: previewOption,
    } = args as PositionArgs;
    const absolutePath = resolvePath(file_path);
    // Before the position lookup and the provider call: an invalid width costs nothing.
    const preview = createSourcePreview(previewOption);
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
                const file = uriToPath(item.uri);
                return [
                  `• ${item.name} (${client.symbolKindToString(item.kind)}) at ${file}:${start.line + 1}:${start.character + 1}${item.detail ? ` - ${item.detail}` : ''}`,
                  ...previewWindow(preview, file, start.line),
                ].join('\n');
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
  // Admitted before the position lookup and both provider requests: an invalid
  // width must cost nothing in either direction, and one owner per call keeps
  // every row after the first in a file free.
  const preview = createSourcePreview(args.preview);
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
      const end = direction === 'incoming' && 'from' in call ? call.from : 'to' in call ? call.to : null;
      if (end) {
        const start = end.selectionRange.start;
        const file = uriToPath(end.uri);
        const window = previewWindow(preview, file, start.line);
        selectedLines.push(
          [
            `• ${end.name} (${client.symbolKindToString(end.kind)}) at ${file}:${start.line + 1}:${start.character + 1}`,
            ...window,
          ].join('\n')
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
