import type { LSPClient } from '../lsp-client.js';
import {
  formatLocations,
  resolvePath,
  rethrowToolOutcome,
  textResult,
  withWarning,
} from './helpers.js';
import {
  positionResolutionResult,
  resolveToolPosition,
  resolvedFromMetadata,
  resolvedFromText,
} from './position-resolver.js';
import type { ToolDefinition } from './registry.js';

export const findDefinitionTool: ToolDefinition = {
  name: 'find_definition',
  description:
    'Find the definition of a symbol by name and kind in a file. Returns definitions for all matching symbols.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file',
      },
      symbol_name: {
        type: 'string',
        description: 'The name of the symbol',
      },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol (function, class, variable, method, etc.)',
      },
    },
    required: ['file_path', 'symbol_name'],
  },
  handler: async (args, client) => {
    const { file_path, symbol_name, symbol_kind } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
    };
    const absolutePath = resolvePath(file_path);

    try {
      const result = await client.findDefinitionsWithProvider(
        absolutePath,
        symbol_name,
        symbol_kind
      );
      if (result.outcome !== 'ok') {
        return {
          content: [{ type: 'text', text: `${result.code}: ${result.reason}` }],
          structuredContent: result,
          isError: true,
        };
      }
      const text =
        result.value.length > 0
          ? `Found ${result.value.length} definition(s) for "${symbol_name}" (${result.provider}):\n${result.provider === 'lsp' && result.matchedDescriptions?.length ? `${result.matchedDescriptions.join(', ')}\n` : ''}${formatLocations(result.value)}`
          : result.provider === 'lsp' && result.matchedSymbols === 0
            ? `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}.`
            : `Found ${result.provider === 'lsp' ? (result.matchedSymbols ?? 0) : 0} symbol(s) but no definitions could be retrieved (${result.provider}).`;
      return {
        content: [
          {
            type: 'text',
            text: withWarning(result.provider === 'lsp' ? result.warning : undefined, text),
          },
        ],
        structuredContent: {
          outcome: 'ok',
          provider: result.provider,
          locations: result.value,
          ...(result.provider === 'tree-sitter'
            ? { limitations: result.limitations, truncated: result.truncated ?? false }
            : {}),
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const findReferencesTool: ToolDefinition = {
  name: 'find_references',
  description:
    'Find all references to a symbol across the entire workspace. Returns references for all matching symbols.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file where the symbol is defined',
      },
      symbol_name: {
        type: 'string',
        description: 'The name of the symbol',
      },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol (function, class, variable, method, etc.)',
      },
      include_declaration: {
        type: 'boolean',
        description: 'Whether to include the declaration',
        default: true,
      },
    },
    required: ['file_path', 'symbol_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      symbol_name,
      symbol_kind,
      include_declaration = true,
    } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      include_declaration?: boolean;
    };
    const absolutePath = resolvePath(file_path);

    const result = await client.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
    const { matches: symbolMatches, warning } = result;

    if (symbolMatches.length === 0) {
      return textResult(
        withWarning(
          warning,
          `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
        )
      );
    }

    const results = [];
    for (const match of symbolMatches) {
      try {
        const locations = await client.findReferences(
          absolutePath,
          match.position,
          include_declaration
        );

        if (locations.length > 0) {
          const locationResults = formatLocations(locations);
          results.push(
            `Results for ${match.name} (${client.symbolKindToString(match.kind)}) at ${file_path}:${match.position.line + 1}:${match.position.character + 1}:\n${locationResults}`
          );
        }
      } catch (error) {
        rethrowToolOutcome(error);
        // Continue trying other symbols if one fails
      }
    }

    if (results.length === 0) {
      return textResult(
        withWarning(
          warning,
          `Found ${symbolMatches.length} symbol(s) but no references could be retrieved. Please ensure the language server is properly configured.`
        )
      );
    }

    return textResult(withWarning(warning, results.join('\n\n')));
  },
};

export const findImplementationTool: ToolDefinition = {
  name: 'find_implementation',
  description: 'Find implementations by symbol query or 1-indexed position.',
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
      const locations = await client.findImplementation(absolutePath, resolution.position);
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      if (locations.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}No implementations found at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            locations: [],
          },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `${resolved ? `${resolved}\n\n` : ''}Found ${locations.length} implementation(s):\n\n${formatLocations(locations)}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          locations,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      return textResult(
        `Error finding implementations: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const navigationTools: ToolDefinition[] = [
  findDefinitionTool,
  findReferencesTool,
  findImplementationTool,
];
