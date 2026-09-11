import type { LSPClient } from '../lsp-client.js';
import type { Position } from '../lsp/types.js';
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
  NAMED_QUERY_SCHEMA,
  type NamedRows,
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
import type { ToolDefinition } from './registry.js';

function hoverContents(result: NonNullable<Awaited<ReturnType<LSPClient['hover']>>>): string {
  return typeof result.contents === 'string'
    ? result.contents
    : result.contents?.value || JSON.stringify(result.contents);
}

async function hoverForNames(
  client: LSPClient,
  absolutePath: string,
  filePath: string,
  queries: string[],
  maxResults: number
) {
  const resolutions = [];
  for (const query of queries) {
    resolutions.push({
      query,
      resolution: await resolveToolPosition(absolutePath, { query }, client),
    });
  }
  const resolved = resolutions.filter(
    (
      entry
    ): entry is typeof entry & {
      resolution: Extract<typeof entry.resolution, { outcome: 'resolved' }>;
    } => entry.resolution.outcome === 'resolved'
  );
  const hovers =
    resolved.length > 0
      ? await client.hoverBatch(
          absolutePath,
          resolved.map((entry) => entry.resolution.position)
        )
      : [];
  let hoverIndex = 0;
  type HoverResult = NonNullable<Awaited<ReturnType<LSPClient['hover']>>>;
  type HoverMetadata = {
    resolution: 'resolved' | 'unavailable' | 'ambiguous' | 'not_found' | 'invalid';
    reason: string | null;
    position: Position | null;
  };
  const answers: Array<NamedRows<HoverResult, HoverMetadata>> = resolutions.map((entry) => {
    if (entry.resolution.outcome !== 'resolved') {
      const rendered = positionResolutionResult(entry.resolution, filePath);
      return {
        query: entry.query,
        rows: [] as HoverResult[],
        metadata: {
          resolution: entry.resolution.outcome,
          reason: rendered.content[0]?.text ?? 'Symbol could not be resolved',
          position: null,
        },
      };
    }
    const hover = hovers[hoverIndex++];
    return {
      query: entry.query,
      rows: hover ? [hover] : [],
      metadata: {
        resolution: 'resolved' as const,
        reason: null,
        position: entry.resolution.position,
      },
    };
  });
  const bounded = boundNamedRows(answers, maxResults);
  const perQuery = bounded.perQuery.map(({ rows, ...row }) => ({
    ...row,
    hover: rows[0] ?? null,
    outcome: namedQueryOutcome(row.resolution, row.total, row.shown),
  }));
  const unresolved = perQuery.some((row) => namedQueryResolutionFailed(row.resolution));
  const resultFile =
    bounded.omitted > 0
      ? spoolFullResult('get_hover', {
          file: absolutePath,
          queries,
          total: bounded.total,
          perQuery: answers.map((answer) => ({
            query: answer.query,
            total: answer.rows.length,
            hovers: answer.rows,
            ...answer.metadata,
          })),
        })
      : null;
  return {
    content: [
      {
        type: 'text' as const,
        text: [
          `Hover (${bounded.rows.length}/${bounded.total}) for ${queries.length} names:`,
          ...perQuery.flatMap((row) => [
            `  "${row.query}": ${row.total} hover result(s)${row.resolution !== 'resolved' ? ` — ${row.reason}` : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`,
            ...(row.hover ? [hoverContents(row.hover)] : []),
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
      file: absolutePath,
      hovers: bounded.rows,
      shown: bounded.rows.length,
      total: bounded.total,
      omitted: bounded.omitted,
      queries,
      perQuery,
      recovery:
        bounded.omitted > 0
          ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the hover query.`
          : null,
      ...(resultFile ? { resultFile } : {}),
    },
    ...(unresolved ? { isError: true } : {}),
  };
}

export const getHoverTool: ToolDefinition = {
  name: 'get_hover',
  description:
    'Get hover information by one symbol query or an array of names under one freshness batch, or by exact 1-indexed position(s).',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      positions: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            line: { type: 'integer', minimum: 1 },
            character: { type: 'integer', minimum: 1 },
          },
          required: ['line', 'character'],
          additionalProperties: false,
        },
        description:
          'Exact 1-indexed positions in this file, returned in order under one freshness check. Excludes query/line/character.',
      },
      query: {
        ...NAMED_QUERY_SCHEMA,
        description:
          'Symbol query (alternative to line/character). Pass an array to ask several names in one freshness-checked batch.',
      },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
      max_results: {
        type: 'number',
        description: `Hover results to return across every name (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, query, line, character, max_results } = args as {
      file_path: string;
      query?: string | string[];
      line?: number;
      character?: number;
      max_results?: number;
    };
    const absolutePath = resolvePath(file_path);
    try {
      const positions = (args as { positions?: unknown }).positions;
      if (positions !== undefined) {
        if (
          query !== undefined ||
          line !== undefined ||
          character !== undefined ||
          !Array.isArray(positions) ||
          positions.length === 0 ||
          positions.some(
            (p) =>
              !p ||
              !Number.isSafeInteger(p.line) ||
              p.line < 1 ||
              !Number.isSafeInteger(p.character) ||
              p.character < 1
          )
        ) {
          return {
            content: [
              {
                type: 'text',
                text: 'Provide nonempty exact positions, without query/line/character.',
              },
            ],
            structuredContent: { outcome: 'rejected', code: 'HOVER_POSITIONS_INVALID' },
            isError: true,
          };
        }
        const results = await client.hoverBatch(
          absolutePath,
          positions.map((p) => ({ line: p.line - 1, character: p.character - 1 }))
        );
        const complete = {
          outcome: 'ok',
          provider: 'lsp',
          file: absolutePath,
          positions,
          hovers: results,
          shown: results.length,
          total: positions.length,
          omitted: 0,
        };
        if (Buffer.byteLength(JSON.stringify(complete), 'utf8') > INLINE_RESULT_BYTES) {
          const resultFile = spoolFullResult('get_hover', complete);
          if (!resultFile)
            return {
              content: [
                {
                  type: 'text',
                  text: 'HOVER_RESULT_SPOOL_FAILED: restore writable result storage and retry.',
                },
              ],
              structuredContent: { outcome: 'unavailable', code: 'HOVER_RESULT_SPOOL_FAILED' },
              isError: true,
            };
          return {
            content: [{ type: 'text', text: `Complete hover batch: ${resultFile}` }],
            structuredContent: {
              ...complete,
              hovers: [],
              shown: 0,
              omitted: results.length,
              resultFile,
            },
          };
        }
        return {
          content: [
            {
              type: 'text',
              text: results
                .map(
                  (result, i) =>
                    `${positions[i].line}:${positions[i].character}\n${result ? (typeof result.contents === 'string' ? result.contents : result.contents.value) : 'No hover information'}`
                )
                .join('\n\n'),
            },
          ],
          structuredContent: {
            outcome: 'ok',
            provider: 'lsp',
            file: absolutePath,
            positions,
            hovers: results,
            shown: results.length,
            total: positions.length,
            omitted: 0,
          },
        };
      }
      let queries: string[] | null;
      try {
        queries = normalizeNamedQuerySelector(query, line, character);
      } catch (error) {
        return positionResolutionResult(
          { outcome: 'invalid', reason: error instanceof Error ? error.message : String(error) },
          file_path
        );
      }
      if (queries && queries.length > 1) {
        return await hoverForNames(
          client,
          absolutePath,
          file_path,
          queries,
          boundedResultLimit(max_results)
        );
      }
      const resolution = await resolveToolPosition(
        absolutePath,
        { query: queries?.[0], line, character },
        client
      );
      if (resolution.outcome !== 'resolved') {
        return positionResolutionResult(resolution, file_path);
      }
      const result = await client.hover(absolutePath, resolution.position);
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      if (!result) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}No hover information available at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}`,
            },
          ],
          structuredContent: {
            outcome: 'empty',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            hover: null,
            shown: 0,
            total: 0,
            omitted: 0,
          },
        };
      }
      const hoverText = hoverContents(result);
      return {
        content: [
          {
            type: 'text',
            text: `${resolved ? `${resolved}\n\n` : ''}Hover information at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}:\n\n${hoverText}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          position: resolution.position,
          hover: result,
          shown: 1,
          total: 1,
          omitted: 0,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const hoverTools: ToolDefinition[] = [getHoverTool];
