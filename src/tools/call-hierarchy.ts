/** Call-hierarchy read tools, including attributed multi-name batches. */

import { uriToPath } from '../utils.js';
import {
  SEMANTIC_DEFAULT_LIMIT,
  SEMANTIC_MAX_LIMIT,
  boundedResultLimit,
  resolvePath,
  rethrowToolOutcome,
  spoolFullResult,
} from './helpers.js';
import {
  NAMED_QUERY_SCHEMA,
  boundNamedRows,
  namedQueryOutcome,
  namedQueryResolutionFailed,
  normalizeNamedQuerySelector,
} from './named-query.js';
import {
  positionResolutionResult,
  resolveToolPosition,
  resolvedFromMetadata,
  resolvedFromText,
} from './position-resolver.js';
import type { ToolDefinition, ToolResult } from './registry.js';
import {
  PREVIEW_SCHEMA,
  type PreviewOption,
  type SourcePreview,
  createSourcePreview,
  previewWindow,
} from './source-preview.js';

const positionSchema = {
  type: 'object',
  properties: {
    file_path: { type: 'string', description: 'The path to the file' },
    query: {
      ...NAMED_QUERY_SCHEMA,
      description:
        'Symbol query (alternative to line/character). Pass an array to ask several names in one request; each reports its own item/call count.',
    },
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
  query?: string | string[];
  line?: number;
  character?: number;
  max_results?: number;
  preview?: PreviewOption;
};

type SinglePositionArgs = Omit<PositionArgs, 'query'> & { query?: string };

type PreparedHierarchy =
  | {
      outcome: 'resolved';
      items: Awaited<ReturnType<Parameters<ToolDefinition['handler']>[1]['prepareCallHierarchy']>>;
      position: { line: number; character: number };
      resolved?: string;
      resolvedFrom?: Record<string, unknown>;
    }
  | { outcome: 'unresolved'; result: ToolResult };

/** One position resolution + prepare call shared by prepare/incoming/outgoing and their batches. */
async function loadCallHierarchyItems(
  args: SinglePositionArgs,
  client: Parameters<ToolDefinition['handler']>[1]
): Promise<PreparedHierarchy> {
  const absolutePath = resolvePath(args.file_path);
  const resolution = await resolveToolPosition(
    absolutePath,
    { query: args.query, line: args.line, character: args.character },
    client
  );
  if (resolution.outcome !== 'resolved') {
    return { outcome: 'unresolved', result: positionResolutionResult(resolution, args.file_path) };
  }
  return {
    outcome: 'resolved',
    items: await client.prepareCallHierarchy(absolutePath, resolution.position),
    position: resolution.position,
    ...(resolvedFromText(resolution) ? { resolved: resolvedFromText(resolution) } : {}),
    ...(resolvedFromMetadata(resolution) ? { resolvedFrom: resolvedFromMetadata(resolution) } : {}),
  };
}

function renderPreparedItems(
  loaded: Extract<PreparedHierarchy, { outcome: 'resolved' }>,
  args: SinglePositionArgs,
  client: Parameters<ToolDefinition['handler']>[1],
  preview: SourcePreview | null,
  maxResults: number
): ToolResult {
  const absolutePath = resolvePath(args.file_path);
  const items = loaded.items.slice(0, maxResults);
  const omitted = loaded.items.length - items.length;
  const itemsFile =
    omitted > 0
      ? spoolFullResult('prepare_call_hierarchy', {
          file: absolutePath,
          total: loaded.items.length,
          items: loaded.items,
        })
      : null;
  if (items.length === 0) {
    return {
      content: [
        {
          type: 'text',
          text: `${loaded.resolved ? `${loaded.resolved}\n\n` : ''}No call hierarchy item found at ${args.file_path}:${loaded.position.line + 1}:${loaded.position.character + 1}`,
        },
      ],
      structuredContent: {
        outcome: 'empty',
        provider: 'lsp',
        ...(loaded.resolvedFrom ? { resolvedFrom: loaded.resolvedFrom } : {}),
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
        text: `${loaded.resolved ? `${loaded.resolved}\n\n` : ''}Call hierarchy item(s):\n\n${items
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
          )}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${itemsFile ?? '(spool unavailable)'}` : ''}`,
      },
    ],
    structuredContent: {
      outcome: 'ok',
      provider: 'lsp',
      ...(loaded.resolvedFrom ? { resolvedFrom: loaded.resolvedFrom } : {}),
      items,
      shown: items.length,
      total: loaded.items.length,
      omitted,
      recovery:
        omitted > 0
          ? `Read the complete result at ${itemsFile ?? '(spool unavailable)'} or narrow the selector.`
          : null,
      ...(itemsFile ? { resultFile: itemsFile } : {}),
    },
  };
}

async function prepareCallHierarchyBatch(
  args: PositionArgs,
  queries: string[],
  client: Parameters<ToolDefinition['handler']>[1],
  preview: SourcePreview | null
): Promise<ToolResult> {
  const answers = [];
  for (const query of queries) {
    const loaded = await loadCallHierarchyItems({ ...args, query }, client);
    if (loaded.outcome === 'unresolved') {
      answers.push({
        query,
        rows: [],
        metadata: {
          resolution:
            loaded.result.structuredContent?.code === 'LSP_SYMBOL_NOT_FOUND'
              ? 'not_found'
              : typeof loaded.result.structuredContent?.outcome === 'string'
                ? loaded.result.structuredContent.outcome
                : 'unavailable',
          reason: loaded.result.content[0]?.text ?? 'Symbol could not be resolved',
          resolvedFrom: null,
        },
      });
    } else {
      answers.push({
        query,
        rows: loaded.items,
        metadata: {
          resolution: 'resolved',
          reason: null,
          resolvedFrom: loaded.resolvedFrom ?? null,
        },
      });
    }
  }
  const bounded = boundNamedRows(answers, boundedResultLimit(args.max_results));
  const perQuery = bounded.perQuery.map(({ rows, ...row }) => ({
    ...row,
    items: rows,
    outcome: namedQueryOutcome(row.resolution, row.total, row.shown),
  }));
  const unresolved = perQuery.some((row) => namedQueryResolutionFailed(row.resolution));
  const resultFile =
    bounded.omitted > 0
      ? spoolFullResult('prepare_call_hierarchy', {
          file: resolvePath(args.file_path),
          queries,
          total: bounded.total,
          perQuery: answers.map((answer) => ({
            query: answer.query,
            total: answer.rows.length,
            items: answer.rows,
            ...answer.metadata,
          })),
        })
      : null;
  return {
    content: [
      {
        type: 'text',
        text: [
          `Call hierarchy prepare (${bounded.rows.length}/${bounded.total}) for ${queries.length} names:`,
          ...perQuery.map(
            (row) =>
              `  "${row.query}": ${row.total} item(s)${row.resolution !== 'resolved' ? ` — ${row.reason}` : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`
          ),
          ...perQuery
            .filter((row) => row.shown > 0)
            .flatMap((row) => [
              '',
              `"${row.query}"`,
              ...row.items.map((item) => {
                const start = item.selectionRange.start;
                const file = uriToPath(item.uri);
                return [
                  `• ${item.name} (${client.symbolKindToString(item.kind)}) at ${file}:${start.line + 1}:${start.character + 1}`,
                  ...previewWindow(preview, file, start.line),
                ].join('\n');
              }),
            ]),
          ...(bounded.omitted > 0
            ? [
                `... ${bounded.omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`,
              ]
            : []),
        ].join('\n'),
      },
    ],
    structuredContent: {
      outcome: unresolved ? 'partial' : bounded.rows.length > 0 ? 'ok' : 'empty',
      ...(unresolved ? { partial: true } : {}),
      provider: 'lsp',
      items: bounded.rows,
      shown: bounded.rows.length,
      total: bounded.total,
      omitted: bounded.omitted,
      queries,
      perQuery,
      recovery:
        bounded.omitted > 0
          ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the prepare query.`
          : null,
      ...(resultFile ? { resultFile } : {}),
    },
    ...(unresolved ? { isError: true } : {}),
  };
}

export const prepareCallHierarchyTool: ToolDefinition = {
  name: 'prepare_call_hierarchy',
  description:
    'Get call hierarchy items by one symbol query or an array of names (each count attributable), or by one exact 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    const input = args as PositionArgs;
    const preview = createSourcePreview(input.preview);
    try {
      let queries: string[] | null;
      try {
        queries = normalizeNamedQuerySelector(input.query, input.line, input.character);
      } catch (error) {
        return positionResolutionResult(
          { outcome: 'invalid', reason: error instanceof Error ? error.message : String(error) },
          input.file_path
        );
      }
      if (queries && queries.length > 1) {
        return await prepareCallHierarchyBatch(input, queries, client, preview);
      }
      const loaded = await loadCallHierarchyItems({ ...input, query: queries?.[0] }, client);
      if (loaded.outcome === 'unresolved') return loaded.result;
      return renderPreparedItems(
        loaded,
        { ...input, query: queries?.[0] },
        client,
        preview,
        boundedResultLimit(input.max_results)
      );
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

async function loadHierarchyCalls(
  direction: 'incoming' | 'outgoing',
  args: SinglePositionArgs,
  client: Parameters<ToolDefinition['handler']>[1]
): Promise<
  | { outcome: 'unresolved'; result: ToolResult }
  | {
      outcome: 'resolved';
      calls: unknown[];
      itemCount: number;
      position: { line: number; character: number };
      resolved?: string;
      resolvedFrom?: Record<string, unknown>;
    }
> {
  const loaded = await loadCallHierarchyItems(args, client);
  if (loaded.outcome === 'unresolved') return loaded;
  const calls: unknown[] = [];
  for (const item of loaded.items) {
    calls.push(
      ...(direction === 'incoming'
        ? await client.incomingCalls(item)
        : await client.outgoingCalls(item))
    );
  }
  return {
    outcome: 'resolved',
    calls,
    itemCount: loaded.items.length,
    position: loaded.position,
    ...(loaded.resolved ? { resolved: loaded.resolved } : {}),
    ...(loaded.resolvedFrom ? { resolvedFrom: loaded.resolvedFrom } : {}),
  };
}

function renderHierarchyCall(
  direction: 'incoming' | 'outgoing',
  call: unknown,
  client: Parameters<ToolDefinition['handler']>[1],
  preview: SourcePreview | null
): string | null {
  if (!call || typeof call !== 'object') return null;
  const value = call as Record<string, unknown>;
  const end = direction === 'incoming' ? value.from : value.to;
  if (!end || typeof end !== 'object') return null;
  const item = end as {
    name: string;
    kind: number;
    uri: string;
    selectionRange: { start: { line: number; character: number } };
  };
  const start = item.selectionRange.start;
  const file = uriToPath(item.uri);
  return [
    `• ${item.name} (${client.symbolKindToString(item.kind)}) at ${file}:${start.line + 1}:${start.character + 1}`,
    ...previewWindow(preview, file, start.line),
  ].join('\n');
}

async function callHierarchyResult(
  direction: 'incoming' | 'outgoing',
  args: SinglePositionArgs,
  client: Parameters<ToolDefinition['handler']>[1],
  sharedPreview?: SourcePreview | null
): Promise<ToolResult> {
  const absolutePath = resolvePath(args.file_path);
  // The batch supplies one cache for every name; a single call creates one here.
  const preview = sharedPreview === undefined ? createSourcePreview(args.preview) : sharedPreview;
  const loaded = await loadHierarchyCalls(direction, args, client);
  if (loaded.outcome === 'unresolved') return loaded.result;
  const resolved = loaded.resolved;
  const resolvedFrom = loaded.resolvedFrom;
  if (loaded.itemCount === 0) {
    return {
      content: [
        {
          type: 'text' as const,
          text: `${resolved ? `${resolved}\n\n` : ''}No call hierarchy item found at ${args.file_path}:${loaded.position.line + 1}:${loaded.position.character + 1}`,
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
  const total = loaded.calls.length;
  const selectedCalls = loaded.calls.slice(0, limit);
  const selectedLines = selectedCalls
    .map((call) => renderHierarchyCall(direction, call, client, preview))
    .filter((line): line is string => line !== null);
  const omitted = total - selectedCalls.length;
  const callsFile =
    omitted > 0
      ? spoolFullResult(`get_${direction}_calls`, {
          file: absolutePath,
          direction,
          total,
          calls: loaded.calls,
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

async function callHierarchyBatchResult(
  direction: 'incoming' | 'outgoing',
  args: PositionArgs,
  queries: string[],
  client: Parameters<ToolDefinition['handler']>[1],
  preview: SourcePreview | null
): Promise<ToolResult> {
  const answers = [];
  for (const query of queries) {
    const loaded = await loadHierarchyCalls(direction, { ...args, query }, client);
    if (loaded.outcome === 'unresolved') {
      const structured = loaded.result.structuredContent ?? {};
      const resolution =
        structured.code === 'LSP_SYMBOL_NOT_FOUND'
          ? 'not_found'
          : typeof structured.outcome === 'string'
            ? structured.outcome
            : 'unavailable';
      answers.push({
        query,
        rows: [],
        metadata: {
          resolution,
          reason: loaded.result.content[0]?.text ?? 'Symbol could not be resolved',
          resolvedFrom: null,
        },
      });
    } else {
      answers.push({
        query,
        rows: loaded.calls,
        metadata: {
          resolution: 'resolved',
          reason: null,
          resolvedFrom: loaded.resolvedFrom ?? null,
        },
      });
    }
  }
  const bounded = boundNamedRows(answers, boundedResultLimit(args.max_results));
  const perQuery = bounded.perQuery.map(({ rows, ...row }) => ({
    ...row,
    calls: rows,
    outcome: namedQueryOutcome(row.resolution, row.total, row.shown),
  }));
  const unresolved = perQuery.some((row) => namedQueryResolutionFailed(row.resolution));
  const resultFile =
    bounded.omitted > 0
      ? spoolFullResult(`get_${direction}_calls`, {
          file: resolvePath(args.file_path),
          direction,
          queries,
          total: bounded.total,
          perQuery: answers.map((answer) => ({
            query: answer.query,
            total: answer.rows.length,
            calls: answer.rows,
            ...answer.metadata,
          })),
        })
      : null;
  return {
    content: [
      {
        type: 'text',
        text: [
          `${direction === 'incoming' ? 'Incoming' : 'Outgoing'} calls (${bounded.rows.length}/${bounded.total}) for ${queries.length} names:`,
          ...perQuery.map(
            (row) =>
              `  "${row.query}": ${row.total} call(s)${row.resolution !== 'resolved' ? ` — ${row.reason}` : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`
          ),
          ...perQuery
            .filter((row) => row.shown > 0)
            .flatMap((row) => [
              '',
              `"${row.query}"`,
              ...row.calls
                .map((call) => renderHierarchyCall(direction, call, client, preview))
                .filter((line): line is string => line !== null),
            ]),
          ...(bounded.omitted > 0
            ? [
                `... ${bounded.omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`,
              ]
            : []),
        ].join('\n'),
      },
    ],
    structuredContent: {
      outcome: unresolved ? 'partial' : bounded.rows.length > 0 ? 'ok' : 'empty',
      ...(unresolved ? { partial: true } : {}),
      provider: 'lsp',
      calls: bounded.rows,
      shown: bounded.rows.length,
      total: bounded.total,
      omitted: bounded.omitted,
      queries,
      perQuery,
      recovery:
        bounded.omitted > 0
          ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the call query.`
          : null,
      ...(resultFile ? { resultFile } : {}),
    },
    ...(unresolved ? { isError: true } : {}),
  };
}

async function namedCallHierarchyTool(
  direction: 'incoming' | 'outgoing',
  args: PositionArgs,
  client: Parameters<ToolDefinition['handler']>[1]
): Promise<ToolResult> {
  // Before query admission, position lookup and provider requests: one preview
  // cache for every name, and an invalid width costs nothing.
  const preview = createSourcePreview(args.preview);
  let queries: string[] | null;
  try {
    queries = normalizeNamedQuerySelector(args.query, args.line, args.character);
  } catch (error) {
    return positionResolutionResult(
      { outcome: 'invalid', reason: error instanceof Error ? error.message : String(error) },
      args.file_path
    );
  }
  if (queries && queries.length > 1) {
    return await callHierarchyBatchResult(direction, args, queries, client, preview);
  }
  return await callHierarchyResult(direction, { ...args, query: queries?.[0] }, client, preview);
}

export const getIncomingCallsTool: ToolDefinition = {
  name: 'get_incoming_calls',
  description:
    'Find incoming calls by one symbol query or an array of names (each count attributable), or by one exact 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    try {
      return await namedCallHierarchyTool('incoming', args as PositionArgs, client);
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const getOutgoingCallsTool: ToolDefinition = {
  name: 'get_outgoing_calls',
  description:
    'Find outgoing calls by one symbol query or an array of names (each count attributable), or by one exact 1-indexed position.',
  inputSchema: positionSchema,
  handler: async (args, client) => {
    try {
      return await namedCallHierarchyTool('outgoing', args as PositionArgs, client);
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const callHierarchyTools: ToolDefinition[] = [
  prepareCallHierarchyTool,
  getIncomingCallsTool,
  getOutgoingCallsTool,
];
