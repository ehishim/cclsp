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
import { NAMED_QUERY_SCHEMA, boundNamedRows, normalizeNamedQueries } from './named-query.js';
import type { ToolDefinition } from './registry.js';
import {
  PREVIEW_SCHEMA,
  type SourcePreview,
  createSourcePreview,
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
 * A language server answers `workspace/symbol` from the program(s) it has
 * LOADED, not from the repository. Priming proves those programs answer before a
 * zero is reported, so a confirmed zero means "not in the loaded program graph":
 * a real negative for project source, still silent about excluded folders,
 * scripts and other languages. Before that proof the zero is `stale`, and the
 * only correct act is to retry, not to search elsewhere.
 */
const NO_MATCH_RECOVERY =
  'No match in the loaded program graph. Repository-wide (excluded folders, scripts, other languages): ast_search.';
const STALE_RECOVERY =
  'The project graph is still loading, so this zero is not an answer yet. Retry the same call once it finishes.';
const zeroNote = (confirmed: boolean) =>
  confirmed ? 'no match in the loaded program graph' : 'index still loading — retry';

interface WorkspaceQueryAnswer {
  query: string;
  symbols: SymbolInformation[];
  readinessConfirmed: boolean;
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
        ...NAMED_QUERY_SCHEMA,
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
      const queries = normalizeNamedQueries(query);
      const limit = boundedResultLimit(max_results);
      const answers: WorkspaceQueryAnswer[] = await Promise.all(
        queries.map(async (name) => ({ query: name, ...(await client.workspaceSymbol(name)) }))
      );

      const bounded = boundNamedRows(
        answers.map((answer) => ({
          query: answer.query,
          rows: answer.symbols,
          metadata: { readinessConfirmed: answer.readinessConfirmed },
        })),
        limit
      );
      const perQuery = bounded.perQuery.map(({ rows, ...row }) => ({
        ...row,
        symbols: rows,
        // Per name, because the provider answers each request on its own state.
        // A name cut by the shared row bound is `partial`, never a false zero.
        outcome:
          row.shown > 0
            ? ('ok' as const)
            : row.total > 0
              ? ('partial' as const)
              : row.readinessConfirmed
                ? ('empty' as const)
                : ('stale' as const),
      }));

      const selected = bounded.rows;
      const total = bounded.total;
      const omitted = bounded.omitted;
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
          ? `Workspace symbols (0/0) matching "${single.query}" · ${zeroNote(single.readinessConfirmed)}`
          : [
              `Workspace symbols (${single.shown}/${single.total}) matching "${single.query}" · provider lsp`,
              ...single.symbols.map((symbol) => renderWorkspaceRow(symbol, client, previewCache)),
              ...omittedLine,
            ].join('\n')
        : [
            `Workspace symbols (${selected.length}/${total}) matching ${queries.length} names · provider lsp`,
            ...perQuery.map(
              (row) =>
                `  "${row.query}": ${row.total} match(es)${row.total === 0 ? ` — ${zeroNote(row.readinessConfirmed)}` : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`
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
          // `empty` is a SCOPED negative: no match in the loaded program graph,
          // proven answering. Repository-wide absence belongs to the structural
          // tier. Before the provider is proven answering, zero rows is `stale`.
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
              : !readinessConfirmed
                ? STALE_RECOVERY
                : selected.length === 0
                  ? NO_MATCH_RECOVERY
                  : perQuery.some((row) => row.total === 0)
                    ? `No match for ${perQuery
                        .filter((row) => row.total === 0)
                        .map((row) => `"${row.query}"`)
                        .join(', ')}. ${NO_MATCH_RECOVERY}`
                    : null,
          ...(resultFile ? { resultFile } : {}),
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const symbolTools: ToolDefinition[] = [getDocumentSymbolsTool, findWorkspaceSymbolsTool];
