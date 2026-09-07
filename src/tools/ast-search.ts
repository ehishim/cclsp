import { AST_LANGUAGES, type AstPatternReport, type AstSearchOutcome } from '../ast/types.js';
import { codeRewriteTool } from './code-rewrite.js';
import type { ToolDefinition, ToolResult } from './registry.js';

/**
 * The two incomplete-file codes mean opposite things to a reader, so the text
 * says which one happened. A failed file was never searched, so it may hide
 * anything; a recovered file WAS searched, so its matches are real and only its
 * silence is unproven. Rendering both as "failed" would throw that away.
 */
const INCOMPLETE_FILE_MEANING = {
  AST_PARSE_FAILED: 'unreadable — not searched',
  AST_PARSE_RECOVERED: 'searched from a recovered tree — absence here is unproven',
} as const;

function renderPatternRow(report: AstPatternReport): string {
  const count =
    report.completeness === 'unknown'
      ? `${report.pattern}: unknown — scan incomplete`
      : report.completeness === 'lower-bound'
        ? `${report.pattern}: at least ${report.matches} match(es) — scan incomplete`
        : `${report.pattern}: ${report.matches} match(es)`;
  return report.note ? `  ${count} — ${report.note}` : `  ${count}`;
}

/**
 * A single pattern keeps its existing shape, because the header already carries
 * its count and repeating it would be noise. Several patterns always break the
 * total down: an aggregate would hide which pattern found nothing, which is the
 * same false absence one call would then hide once per pattern.
 */
function renderPatternBreakdown(perPattern: AstPatternReport[] | undefined): string {
  // An older daemon answering a newer client sends no breakdown at all. Losing
  // the per-pattern rows is acceptable; throwing away the matches with them is not.
  if (!Array.isArray(perPattern) || perPattern.length === 0) return '';
  if (perPattern.length > 1) return perPattern.map(renderPatternRow).join('\n');
  const only = perPattern[0];
  return only?.note ? renderPatternRow(only) : '';
}

function renderMatches(result: Extract<AstSearchOutcome, { outcome: 'ok' | 'partial' }>): string {
  return result.matches
    .map((match) => {
      const start = match.range.start;
      const captures = match.captures
        .map((capture) => {
          const captureStart = capture.range.start;
          return `  $${capture.variadic ? '$$' : ''}${capture.name} @ ${captureStart.line + 1}:${captureStart.character + 1} = ${capture.text}`;
        })
        .join('\n');
      const origin = match.recovered ? ' (recovered file)' : '';
      return `${match.file}:${start.line + 1}:${start.character + 1}${origin}\n${match.text}${captures ? `\n${captures}` : ''}`;
    })
    .join('\n\n');
}

function renderText(result: AstSearchOutcome): string {
  if (result.outcome === 'rejected') return `${result.code}: ${result.reason}`;
  if (result.outcome === 'partial') {
    const header = `${result.code}: AST search (${result.provider}, ${result.language}) searched ${result.filesScanned} file(s) but cannot prove absence: ${result.parseFailureCount} file(s) did not parse completely.`;
    const breakdown = result.perPattern.map(renderPatternRow).join('\n');
    const failedFiles = result.failedFiles
      .map(
        (failure) => `  ${failure.file}: ${failure.code} — ${INCOMPLETE_FILE_MEANING[failure.code]}`
      )
      .join('\n');
    const summary = [
      header,
      breakdown,
      `Incomplete files (${result.failedFiles.length}/${result.parseFailureCount} shown):`,
      failedFiles,
      `Recovery: ${result.recovery}`,
    ]
      .filter(Boolean)
      .join('\n');
    return result.matches.length === 0 ? summary : `${summary}\n\n${renderMatches(result)}`;
  }
  const header = [
    `AST search (${result.provider}, ${result.language})`,
    `${result.matches.length} match(es) across ${result.filesScanned} parsed file(s)`,
    `truncated=${result.truncated} indexCapped=${result.indexCapped} partial=${result.partial}`,
  ].join(' — ');
  const breakdown = renderPatternBreakdown(result.perPattern);
  const summary = breakdown ? `${header}\n${breakdown}` : header;
  return result.matches.length === 0 ? summary : `${summary}\n\n${renderMatches(result)}`;
}

function toolResult(result: AstSearchOutcome): ToolResult {
  return {
    content: [{ type: 'text', text: renderText(result) }],
    structuredContent: { ...result },
    ...(result.outcome !== 'ok' ? { isError: true } : {}),
  };
}

export const astSearchTool: ToolDefinition = {
  name: 'ast_search',
  description:
    'Find code by name or syntax shape. A bare name finds identifier, method/property and type-name occurrences, not comments or string text. $NAME captures one named node and $$$NAME captures zero or more named siblings. Use semantic references before renaming.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: ['string', 'array'],
        items: { type: 'string' },
        description:
          'Structural pattern with $NAME and $$$NAME metavariables. Pass an array (or repeat --pattern) to search several patterns in one scan; complete scans report exact counts, while an unproven zero in a partial scan reports unknown. Regex syntax is never interpreted, so alternation is expressed as separate patterns, not as "a|b".',
      },
      language: {
        type: 'string',
        // Derived from the one language table, so an added language can never
        // ship a schema that still advertises the old set.
        description: AST_LANGUAGES.join(', '),
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
      pattern: string | string[];
      language: string;
      path?: string;
      max_results?: number;
    };
    return toolResult(await client.astSearch({ pattern, language, path, maxResults: max_results }));
  },
};

export const astTools: ToolDefinition[] = [astSearchTool, codeRewriteTool];
