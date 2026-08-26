import { resolvePath, rethrowToolOutcome } from './helpers.js';
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
            outcome: 'empty', provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            hover: null, shown: 0, total: 0, omitted: 0,
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
          outcome: 'ok', provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          position: resolution.position,
          hover: result,
          shown: 1, total: 1, omitted: 0,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const hoverTools: ToolDefinition[] = [getHoverTool];
