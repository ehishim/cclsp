import {
  INLINE_RESULT_BYTES,
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

export const getHoverTool: ToolDefinition = {
  name: 'get_hover',
  description: 'Get hover information by symbol query or 1-indexed position.',
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
      query: { type: 'string', description: 'Symbol query (alternative to line/character)' },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, query, line, character } = args as {
      file_path: string;
      query?: string;
      line?: number;
      character?: number;
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
      const resolution = await resolveToolPosition(
        absolutePath,
        { query, line, character },
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
      const hoverText =
        typeof result.contents === 'string'
          ? result.contents
          : result.contents?.value || JSON.stringify(result.contents);
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
