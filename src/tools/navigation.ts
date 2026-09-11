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
import type { ToolDefinition, ToolResult } from './registry.js';
import {
  PREVIEW_SCHEMA,
  type PreviewOption,
  createSourcePreview,
} from './source-preview.js';

type NavigationSelector =
  | { outcome: 'name'; symbolName: string; symbolNames: string[]; symbolKind?: string }
  | { outcome: 'position'; line: number; character: number }
  | { outcome: 'invalid'; reason: string };

function selectNavigationArgs(args: {
  symbol_name?: unknown;
  symbol_kind?: unknown;
  line?: unknown;
  character?: unknown;
}): NavigationSelector {
  const namePresent = args.symbol_name !== undefined;
  const linePresent = args.line !== undefined;
  const characterPresent = args.character !== undefined;

  if (linePresent !== characterPresent) {
    return { outcome: 'invalid', reason: 'line and character must be provided together' };
  }
  if (namePresent === linePresent) {
    return {
      outcome: 'invalid',
      reason: 'provide exactly one selector: symbol_name or line/character',
    };
  }
  if (namePresent) {
    // One name or several, asked in one request. Entries are kept as given,
    // duplicates included, so the answer's breakdown lines up with the array the
    // caller sent; collapsing them would return fewer rows than it listed.
    const entries = Array.isArray(args.symbol_name) ? args.symbol_name : [args.symbol_name];
    if (entries.length === 0) {
      return { outcome: 'invalid', reason: 'symbol_name must name at least one symbol' };
    }
    const symbolNames: string[] = [];
    for (const entry of entries) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        return { outcome: 'invalid', reason: 'symbol_name must not be empty' };
      }
      symbolNames.push(entry.trim());
    }
    if (args.symbol_kind !== undefined && typeof args.symbol_kind !== 'string') {
      return { outcome: 'invalid', reason: 'symbol_kind must be a string' };
    }
    return {
      outcome: 'name',
      symbolName: symbolNames[0] as string,
      symbolNames,
      ...(typeof args.symbol_kind === 'string' ? { symbolKind: args.symbol_kind } : {}),
    };
  }
  if (args.symbol_kind !== undefined) {
    return { outcome: 'invalid', reason: 'symbol_kind is only valid with symbol_name' };
  }
  if (
    !Number.isInteger(args.line) ||
    !Number.isInteger(args.character) ||
    (args.line as number) < 1 ||
    (args.character as number) < 1
  ) {
    return { outcome: 'invalid', reason: 'line and character must be positive integers' };
  }
  return {
    outcome: 'position',
    line: args.line as number,
    character: args.character as number,
  };
}

function invalidNavigationSelector(
  selector: { outcome: 'invalid'; reason: string },
  file: string
): ToolResult {
  return positionResolutionResult(selector, file);
}

export const findDefinitionTool: ToolDefinition = {
  name: 'find_definition',
  description:
    'Find definitions by symbol name (all exact semantic matches) or one exact 1-indexed position.',
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
        description: 'The kind of symbol; valid only with symbol_name',
      },
      line: {
        type: 'number',
        description: 'Exact line (1-indexed); requires character and excludes symbol_name',
      },
      character: {
        type: 'number',
        description: 'Exact character (1-indexed); requires line and excludes symbol_name',
      },
      max_results: {
        type: 'number',
        description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, symbol_name, symbol_kind, line, character, preview } = args as {
      file_path: string;
      symbol_name?: string;
      symbol_kind?: string;
      line?: number;
      character?: number;
      max_results?: number;
      preview?: PreviewOption;
    };
    const maxResults = boundedResultLimit((args as { max_results?: number }).max_results);
    // Built before any provider request: an invalid preview width must cost
    // nothing, and one owner per call keeps every row after the first free.
    const window = createSourcePreview(preview);
    const absolutePath = resolvePath(file_path);
    const selector = selectNavigationArgs({ symbol_name, symbol_kind, line, character });
    if (selector.outcome === 'invalid') return invalidNavigationSelector(selector, file_path);

    if (selector.outcome === 'position') {
      try {
        const resolution = await resolveToolPosition(
          absolutePath,
          { line: selector.line, character: selector.character },
          client
        );
        if (resolution.outcome !== 'resolved') {
          return positionResolutionResult(resolution, file_path);
        }
        const locations = await client.findDefinition(absolutePath, resolution.position);
        const selected = locations.slice(0, maxResults);
        const omitted = locations.length - selected.length;
        const resultFile =
          omitted > 0
            ? spoolFullResult('find_definition', {
                file: absolutePath,
                position: resolution.position,
                total: locations.length,
                locations,
              })
            : null;
        const text =
          selected.length > 0
            ? `Found ${selected.length}/${locations.length} definition(s) at ${selector.line}:${selector.character} (lsp):\n${formatLocations(selected, window)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`
            : `No definitions found at ${file_path}:${selector.line}:${selector.character} (lsp).`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            outcome: selected.length > 0 ? 'ok' : 'empty',
            provider: 'lsp',
            locations: selected,
            shown: selected.length,
            total: locations.length,
            omitted,
            recovery:
              omitted > 0
                ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the definition query.`
                : null,
            ...(resultFile ? { resultFile } : {}),
          },
        };
      } catch (error) {
        rethrowToolOutcome(error);
        throw error;
      }
    }

    const symbolName = selector.symbolName;
    const symbolKind = selector.symbolKind;
    try {
      const result = await client.findDefinitionsWithProvider(absolutePath, symbolName, symbolKind);
      if (result.outcome !== 'ok') {
        return {
          content: [{ type: 'text', text: `${result.code}: ${result.reason}` }],
          structuredContent: result,
          isError: true,
        };
      }
      const selected = result.value.slice(0, maxResults);
      const omitted = result.value.length - selected.length;
      const resultFile =
        omitted > 0
          ? spoolFullResult('find_definition', {
              file: absolutePath,
              symbol: symbolName,
              total: result.value.length,
              locations: result.value,
            })
          : null;
      const text =
        selected.length > 0
          ? `Found ${selected.length}/${result.value.length} definition(s) for "${symbolName}" (${result.provider}):\n${result.provider === 'lsp' && result.matchedDescriptions?.length ? `${result.matchedDescriptions.join(', ')}\n` : ''}${formatLocations(selected, window)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`
          : result.provider === 'lsp' && result.matchedSymbols === 0
            ? `No symbols found with name "${symbolName}"${symbolKind ? ` and kind "${symbolKind}"` : ''} in ${file_path}.`
            : `Found ${result.provider === 'lsp' ? (result.matchedSymbols ?? 0) : 0} symbol(s) but no definitions could be retrieved (${result.provider}).`;
      return {
        content: [
          {
            type: 'text',
            text: withWarning(result.provider === 'lsp' ? result.warning : undefined, text),
          },
        ],
        structuredContent: {
          outcome:
            result.provider === 'lsp' && result.incomplete
              ? 'partial'
              : result.value.length > 0
                ? 'ok'
                : 'empty',
          ...(result.provider === 'lsp' && result.incomplete
            ? { code: 'LSP_SYMBOL_QUERY_INCOMPLETE', partial: true }
            : {}),
          provider: result.provider,
          locations: selected,
          shown: selected.length,
          total: result.value.length,
          omitted,
          recovery:
            result.provider === 'lsp' && result.incomplete
              ? 'Use an exact line/character with a position-based semantic tool; the by-name occurrence bound was exceeded.'
              : omitted > 0
                ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the definition query.`
                : null,
          ...(resultFile ? { resultFile } : {}),
          ...(result.provider === 'tree-sitter'
            ? { limitations: result.limitations, truncated: result.truncated ?? false }
            : {}),
        },
        ...(result.provider === 'lsp' && result.incomplete ? { isError: true } : {}),
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
    'Find workspace references by symbol name (all exact semantic matches) or one exact 1-indexed position.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file where the symbol is defined',
      },
      symbol_name: {
        anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description:
          'The name of the symbol. Pass an array to ask several names in one request; each reports its own reference count, so a zero among them is attributable and the row bound is spent in asked order.',
      },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol; valid only with symbol_name',
      },
      line: {
        type: 'number',
        description: 'Exact line (1-indexed); requires character and excludes symbol_name',
      },
      character: {
        type: 'number',
        description: 'Exact character (1-indexed); requires line and excludes symbol_name',
      },
      include_declaration: {
        type: 'boolean',
        description: 'Whether to include the declaration',
        default: true,
      },
      max_results: {
        type: 'number',
        description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      symbol_name,
      symbol_kind,
      line,
      character,
      include_declaration = true,
      max_results,
      preview,
    } = args as {
      file_path: string;
      symbol_name?: string;
      symbol_kind?: string;
      line?: number;
      character?: number;
      include_declaration?: boolean;
      max_results?: number;
      preview?: PreviewOption;
    };
    const maxResults = boundedResultLimit(max_results);
    // Built before any provider request: an invalid preview width must cost
    // nothing, and one owner per call keeps every row after the first free.
    const window = createSourcePreview(preview);
    const absolutePath = resolvePath(file_path);
    const selector = selectNavigationArgs({ symbol_name, symbol_kind, line, character });
    if (selector.outcome === 'invalid') return invalidNavigationSelector(selector, file_path);

    if (selector.outcome === 'position') {
      try {
        const resolution = await resolveToolPosition(
          absolutePath,
          { line: selector.line, character: selector.character },
          client
        );
        if (resolution.outcome !== 'resolved') {
          return positionResolutionResult(resolution, file_path);
        }
        const locations = await client.findReferences(
          absolutePath,
          resolution.position,
          include_declaration
        );
        const selected = locations.slice(0, maxResults);
        const omitted = locations.length - selected.length;
        const resultFile =
          omitted > 0
            ? spoolFullResult('find_references', {
                file: absolutePath,
                position: resolution.position,
                total: locations.length,
                locations,
              })
            : null;
        const text =
          selected.length > 0
            ? `References (${selected.length}/${locations.length}) at ${selector.line}:${selector.character}:\n${formatLocations(selected, window)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`
            : `No references found at ${file_path}:${selector.line}:${selector.character} (lsp).`;
        return {
          content: [{ type: 'text', text }],
          structuredContent: {
            outcome: selected.length > 0 ? 'ok' : 'empty',
            provider: 'lsp',
            locations: selected,
            shown: selected.length,
            total: locations.length,
            omitted,
            recovery:
              omitted > 0
                ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the reference query.`
                : null,
            ...(resultFile ? { resultFile } : {}),
          },
        };
      } catch (error) {
        rethrowToolOutcome(error);
        throw error;
      }
    }

    const symbolKind = selector.symbolKind;
    // One request, several names. A caller mapping an unfamiliar area asks about
    // three or four symbols at once, and one call per name costs a whole turn each.
    // Names stay separate in the answer for the same reason the symbol search keeps
    // them separate: a merged list cannot say which name found nothing.
    const answers: Array<{
      name: string;
      locations: Awaited<ReturnType<LSPClient['findReferences']>>;
      warning?: string;
      incomplete: boolean;
      symbolMatches: number;
    }> = [];
    for (const name of selector.symbolNames) {
      const result = await client.findSymbolsByName(absolutePath, name, symbolKind);
      const { matches: symbolMatches, warning, incomplete } = result;
      const unique: Awaited<ReturnType<LSPClient['findReferences']>> = [];
      const seenLocations = new Set<string>();
      for (const match of symbolMatches) {
        try {
          const locations = await client.findReferences(
            absolutePath,
            match.position,
            include_declaration
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
      answers.push({
        name,
        locations: unique,
        ...(warning ? { warning } : {}),
        incomplete: incomplete === true,
        symbolMatches: symbolMatches.length,
      });
    }

    // The bound is spent in asked order, so a later name reports omitted rather
    // than a zero it never earned.
    let remaining = maxResults;
    const perQuery = answers.map((answer) => {
      const selected = answer.locations.slice(0, Math.max(remaining, 0));
      remaining -= selected.length;
      return {
        query: answer.name,
        locations: selected,
        shown: selected.length,
        total: answer.locations.length,
        omitted: answer.locations.length - selected.length,
        symbolMatches: answer.symbolMatches,
        incomplete: answer.incomplete,
        outcome: selected.length > 0
          ? ('ok' as const)
          : answer.locations.length > 0
            ? ('partial' as const)
            : answer.incomplete
              ? ('partial' as const)
              : ('empty' as const),
      };
    });

    const selected = perQuery.flatMap((row) => row.locations);
    const total = answers.reduce((sum, answer) => sum + answer.locations.length, 0);
    const omitted = total - selected.length;
    const incomplete = answers.some((answer) => answer.incomplete);
    const warning = answers.find((answer) => answer.warning)?.warning;
    const single = selector.symbolNames.length === 1 ? perQuery[0] : null;
    const resultFile =
      omitted > 0
        ? spoolFullResult('find_references', {
            file: absolutePath,
            ...(single
              ? { symbol: single.query, locations: answers[0]?.locations ?? [] }
              : {
                  symbols: selector.symbolNames,
                  perQuery: answers.map((answer) => ({
                    query: answer.name,
                    total: answer.locations.length,
                    locations: answer.locations,
                  })),
                }),
            total,
          })
        : null;
    const omittedLine =
      omitted > 0
        ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`
        : '';

    const text = single
      ? single.shown > 0
        ? withWarning(
            warning,
            `References (${single.shown}/${single.total}) for "${single.query}":\n${formatLocations(single.locations, window)}${omittedLine}`
          )
        : withWarning(
            warning,
            single.symbolMatches > 0
              ? `Found ${single.symbolMatches} symbol(s) but no references were returned.`
              : `No symbols found with name "${single.query}"${symbolKind ? ` and kind "${symbolKind}"` : ''} in ${file_path}.`
          )
      : withWarning(
          warning,
          [
            `References (${selected.length}/${total}) for ${selector.symbolNames.length} names:`,
            ...perQuery.map(
              (row) =>
                `  "${row.query}": ${row.total} reference(s)${row.symbolMatches === 0 ? ' — no such symbol in this file' : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`
            ),
            ...perQuery
              .filter((row) => row.shown > 0)
              .flatMap((row) => ['', `"${row.query}"`, formatLocations(row.locations, window)]),
          ].join('\n') + omittedLine
        );

    return {
      content: [{ type: 'text', text }],
      structuredContent: {
        outcome: incomplete ? 'partial' : selected.length > 0 ? 'ok' : 'empty',
        ...(incomplete ? { code: 'LSP_SYMBOL_QUERY_INCOMPLETE', partial: true } : {}),
        provider: 'lsp',
        locations: selected,
        shown: selected.length,
        total,
        omitted,
        ...(single ? {} : { queries: selector.symbolNames, perQuery }),
        recovery: incomplete
          ? 'Use an exact line/character with a position-based semantic tool; the by-name occurrence bound was exceeded.'
          : omitted > 0
            ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the reference query.`
            : null,
        ...(resultFile ? { resultFile } : {}),
      },
      ...(incomplete ? { isError: true } : {}),
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
      max_results: {
        type: 'number',
        description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, query, line, character, max_results, preview } = args as {
      file_path: string;
      query?: string;
      line?: number;
      character?: number;
      max_results?: number;
      preview?: PreviewOption;
    };
    // Same rule here: refuse an invalid width before the implementation lookup.
    const window = createSourcePreview(preview);
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
      const resultFile =
        omitted > 0
          ? spoolFullResult('find_implementation', {
              file: absolutePath,
              total: allLocations.length,
              locations: allLocations,
            })
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
            outcome: 'empty',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            locations: [],
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
            text: `${resolved ? `${resolved}\n\n` : ''}Implementations (${locations.length}/${allLocations.length}):\n\n${formatLocations(locations, window)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          locations,
          shown: locations.length,
          total: allLocations.length,
          omitted,
          recovery:
            omitted > 0
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
