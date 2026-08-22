import type { AstSearchOutcome } from '../ast/types.js';
import type { ToolDefinition, ToolResult } from './registry.js';

function renderText(result: AstSearchOutcome): string {
  if (result.outcome === 'rejected') return `${result.code}: ${result.reason}`;
  const header = [
    `AST search (${result.provider}, ${result.language})`,
    `${result.matches.length} match(es) across ${result.filesScanned} parsed file(s)`,
    `truncated=${result.truncated} indexCapped=${result.indexCapped} partial=${result.partial}`,
  ].join(' — ');
  if (result.matches.length === 0) return header;
  return `${header}\n\n${result.matches
    .map((match) => {
      const start = match.range.start;
      const captures = match.captures
        .map((capture) => {
          const captureStart = capture.range.start;
          return `  $${capture.variadic ? '$$' : ''}${capture.name} @ ${captureStart.line + 1}:${captureStart.character + 1} = ${capture.text}`;
        })
        .join('\n');
      return `${match.file}:${start.line + 1}:${start.character + 1}\n${match.text}${captures ? `\n${captures}` : ''}`;
    })
    .join('\n\n')}`;
}

function toolResult(result: AstSearchOutcome): ToolResult {
  return {
    content: [{ type: 'text', text: renderText(result) }],
    structuredContent: { ...result },
    ...(result.outcome === 'rejected' ? { isError: true } : {}),
  };
}

export const astSearchTool: ToolDefinition = {
  name: 'ast_search',
  description:
    'Search syntax structure with offline Tree-sitter patterns. $NAME captures one named node and $$$NAME captures zero or more named siblings.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description: 'Structural pattern with $NAME and $$$NAME metavariables',
      },
      language: {
        type: 'string',
        description: 'typescript, tsx, javascript, jsx, python, php, go, rust, or java',
      },
      path: {
        type: 'string',
        description: 'Optional root-contained file or directory; defaults to the registered root',
      },
      max_results: {
        type: 'number',
        description: 'Positive result limit (default 100, ceiling 1000)',
        default: 100,
      },
    },
    required: ['pattern', 'language'],
  },
  handler: async (args, client) => {
    const { pattern, language, path, max_results } = args as {
      pattern: string;
      language: string;
      path?: string;
      max_results?: number;
    };
    return toolResult(await client.astSearch({ pattern, language, path, maxResults: max_results }));
  },
};

export const astTools: ToolDefinition[] = [astSearchTool];
