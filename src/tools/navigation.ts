import type { LSPClient } from '../lsp-client.js';
import {
  SEMANTIC_DEFAULT_LIMIT,
  SEMANTIC_MAX_LIMIT,
  boundedResultLimit,
  formatLocations,
  resolvePath,
  rethrowToolOutcome,
  spoolFullResult,
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
      max_results: { type: 'number', description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})` },
    },
    required: ['file_path', 'symbol_name'],
  },
  handler: async (args, client) => {
    const { file_path, symbol_name, symbol_kind } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      max_results?: number;
    };
    const maxResults = boundedResultLimit((args as { max_results?: number }).max_results);
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
      const selected = result.value.slice(0, maxResults);
      const omitted = result.value.length - selected.length;
      const resultFile = omitted > 0
        ? spoolFullResult('find_definition', {
            file: absolutePath, symbol: symbol_name, total: result.value.length, locations: result.value,
          })
        : null;
      const text =
        selected.length > 0
          ? `Found ${selected.length}/${result.value.length} definition(s) for "${symbol_name}" (${result.provider}):\n${result.provider === 'lsp' && result.matchedDescriptions?.length ? `${result.matchedDescriptions.join(', ')}\n` : ''}${formatLocations(selected)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`
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
          outcome: result.value.length > 0 ? 'ok' : 'empty',
          provider: result.provider,
          locations: selected,
          shown: selected.length,
          total: result.value.length,
          omitted,
          recovery: omitted > 0
            ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the definition query.`
            : null,
          ...(resultFile ? { resultFile } : {}),
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
      max_results: { type: 'number', description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})` },
    },
    required: ['file_path', 'symbol_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      symbol_name,
      symbol_kind,
      include_declaration = true,
      max_results,
    } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      include_declaration?: boolean;
      max_results?: number;
    };
    const maxResults = boundedResultLimit(max_results);
    const absolutePath = resolvePath(file_path);

    const result = await client.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
    const { matches: symbolMatches, warning } = result;
    if (symbolMatches.length === 0) {
      const text = withWarning(
        warning,
        `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}.`,
      );
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          outcome: 'empty', provider: 'lsp', locations: [], shown: 0, total: 0, omitted: 0,
        },
      };
    }

    const unique: Awaited<ReturnType<LSPClient['findReferences']>> = [];
    const seenLocations = new Set<string>();
    for (const match of symbolMatches) {
      try {
        const locations = await client.findReferences(
          absolutePath,
          match.position,
          include_declaration,
        );
        for (const location of locations) {
          const range = location.range;
          const key = `${location.uri}\u0000${range.start.line}\u0000${range.start.character}\u0000${range.end.line}\u0000${range.end.character}`;
          if (seenLocations.has(key)) continue;
          seenLocations.add(key);
          unique.push(location);
        }
      } catch (error) {
        rethrowToolOutcome(error);
      }
    }
    const selected = unique.slice(0, maxResults);
    const total = unique.length;
    const omitted = total - selected.length;
    const resultFile = omitted > 0
      ? spoolFullResult('find_references', { file: absolutePath, symbol: symbol_name, total, locations: unique })
      : null;
    const text = selected.length > 0
      ? withWarning(
          warning,
          `References (${selected.length}/${total}) for "${symbol_name}":\n${formatLocations(selected)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`,
        )
      : withWarning(warning, `Found ${symbolMatches.length} symbol(s) but no references were returned.`);
    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        outcome: selected.length > 0 ? 'ok' : 'empty',
        provider: 'lsp',
        locations: selected,
        shown: selected.length,
        total,
        omitted,
        recovery: omitted > 0
          ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the reference query.`
          : null,
        ...(resultFile ? { resultFile } : {}),
      },
    };
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
      max_results: { type: 'number', description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})` },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, query, line, character, max_results } = args as {
      file_path: string;
      query?: string;
      line?: number;
      character?: number;
      max_results?: number;
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
      const allLocations = await client.findImplementation(absolutePath, resolution.position);
      const locations = allLocations.slice(0, boundedResultLimit(max_results));
      const omitted = allLocations.length - locations.length;
      const resultFile = omitted > 0
        ? spoolFullResult('find_implementation', { file: absolutePath, total: allLocations.length, locations: allLocations })
        : null;
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
            outcome: 'empty', provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            locations: [], shown: 0, total: 0, omitted: 0,
          },
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `${resolved ? `${resolved}\n\n` : ''}Implementations (${locations.length}/${allLocations.length}):\n\n${formatLocations(locations)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`,
          },
        ],
        structuredContent: {
          outcome: 'ok', provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          locations,
          shown: locations.length,
          total: allLocations.length,
          omitted,
          recovery: omitted > 0
            ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the selector.`
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

export const navigationTools: ToolDefinition[] = [
  findDefinitionTool,
  findReferencesTool,
  findImplementationTool,
];
