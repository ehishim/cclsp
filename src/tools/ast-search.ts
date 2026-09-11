import { AST_LANGUAGES, type AstPatternReport, type AstSearchOutcome } from '../ast/types.js';
import { codeRewriteTool } from './code-rewrite.js';
import { INLINE_RESULT_BYTES, spoolFullResult } from './helpers.js';
import type { ToolDefinition, ToolResult } from './registry.js';
import {
  PREVIEW_SCHEMA,
  type PreviewOption,
  type SourcePreview,
  createSourcePreview,
  previewSpan,
} from './source-preview.js';

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

/**
 * A bare-name pattern matches the identifier NODE, so `match.text` is the name the
 * caller already typed -- a row that costs a file read to interpret. Every match
 * therefore renders through the one window owner: a name gains the line it sits
 * on, a shape gains numbered lines plus its surroundings, and both are citable by
 * line without recounting. `match.text` remains the fallback when the window
 * cannot be built, so a match is never lost to an unreadable file.
 */
function renderMatches(
  result: Extract<AstSearchOutcome, { outcome: 'ok' | 'partial' }>,
  preview: SourcePreview | null
): string {
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
      const head = `${match.file}:${start.line + 1}:${start.character + 1}${origin}`;
      const window = previewSpan(preview, match.file, start.line, match.range.end.line);
      const body = window.length ? window.join('\n') : match.text;
      return `${head}\n${body}${captures ? `\n${captures}` : ''}`;
    })
    .join('\n\n');
}

function renderText(result: AstSearchOutcome, preview: SourcePreview | null): string {
  if (result.outcome === 'rejected') return `${result.code}: ${result.reason}`;
  if (result.outcome === 'partial') {
    const header = `${result.code}: AST search (${result.provider}, ${result.language}) searched ${result.filesScanned} file(s) but cannot prove absence: ${result.parseFailureCount} file(s) did not parse completely; ${result.filesSkippedOversized} oversized file(s) skipped; indexCapped=${result.indexCapped}.`;
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
    return result.matches.length === 0 ? summary : `${summary}\n\n${renderMatches(result, preview)}`;
  }
  const header = [
    `AST search (${result.provider}, ${result.language})`,
    `${result.matches.length} match(es) across ${result.filesScanned} parsed file(s)`,
    `truncated=${result.truncated} indexCapped=${result.indexCapped} partial=${result.partial}`,
  ].join(' — ');
  const breakdown = renderPatternBreakdown(result.perPattern);
  const summary = breakdown ? `${header}\n${breakdown}` : header;
  return result.matches.length === 0 ? summary : `${summary}\n\n${renderMatches(result, preview)}`;
}

function toolResult(result: AstSearchOutcome, preview: SourcePreview | null): ToolResult {
  // Presentation bounds redirect to complete bytes, never trim match/capture text.
  if (Buffer.byteLength(JSON.stringify(result), 'utf8') > INLINE_RESULT_BYTES) {
    const resultFile = spoolFullResult('ast_search', result);
    if (!resultFile) {
      return {
        content: [
          {
            type: 'text',
            text: 'AST_RESULT_SPOOL_FAILED: complete search result could not be stored; retry after restoring writable result storage.',
          },
        ],
        structuredContent: { outcome: 'unavailable', code: 'AST_RESULT_SPOOL_FAILED' },
        isError: true,
      };
    }
    return {
      content: [
        { type: 'text', text: `AST search ${result.outcome}: complete result at ${resultFile}` },
      ],
      structuredContent: {
        ...result,
        ...('matches' in result
          ? { matches: [], shown: 0, total: result.matches.length, omitted: result.matches.length }
          : {}),
        resultFile,
        recovery: `Read the complete result at ${resultFile}`,
      },
      ...(result.outcome !== 'ok' ? { isError: true } : {}),
    };
  }
  return {
    content: [{ type: 'text', text: renderText(result, preview) }],
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
          'Structural pattern with $NAME and $$$NAME metavariables. Pass an array (or repeat --pattern) to search several patterns in one scan; complete scans report exact counts, while an unproven zero in a partial scan reports unknown. Regex syntax is never interpreted, so alternation is expressed as separate patterns, not as "a|b". In JS/TS, a bare key: value fragment selects an object property; use an explicit statement body for a label.',
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
        description:
          'Optional positive result limit. Omit for all matches; large complete results are spooled.',
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['pattern', 'language'],
  },
  handler: async (args, client) => {
    const { pattern, language, path, max_results, preview } = args as {
      pattern: string | string[];
      language: string;
      path?: string;
      max_results?: number;
      preview?: PreviewOption;
    };
    // Built first on purpose: an invalid preview width must be refused before the
    // scan runs, not after the expensive part of the answer is already paid for.
    const window = createSourcePreview(preview);
    return toolResult(
      await client.astSearch({ pattern, language, path, maxResults: max_results }),
      window
    );
  },
};

export const astTools: ToolDefinition[] = [astSearchTool, codeRewriteTool];
