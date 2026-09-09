import { resolve } from 'node:path';
import { LspToolOutcomeError } from '../lsp/capabilities.js';
import type { Location } from '../lsp/types.js';
import { resultSpoolDir, spoolFullResult } from '../result-spool.js';
import { uriToPath } from '../utils.js';
import type { ToolResult } from './registry.js';

/**
 * Row limits are generous on purpose: a caller mapping architecture needs the
 * whole answer in one read, so the practical bound is the transport byte
 * ceiling rather than an arbitrary row count. `max_results` exists to NARROW a
 * known-broad question, not to trim answers by default.
 */
export const SEMANTIC_DEFAULT_LIMIT = 1_000;
export const SEMANTIC_MAX_LIMIT = 5_000;

export { resultSpoolDir, spoolFullResult };

/** Inline result budget; larger complete results are spooled untrimmed. */
export const INLINE_RESULT_BYTES = 120 * 1024;

export function boundedResultLimit(value: unknown): number {
  if (value === undefined) return SEMANTIC_DEFAULT_LIMIT;
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > SEMANTIC_MAX_LIMIT) {
    throw new Error(`max_results must be an integer from 1 to ${SEMANTIC_MAX_LIMIT}`);
  }
  return Number(value);
}

export function resolvePath(filePath: string): string {
  return resolve(filePath);
}

export function formatLocations(locations: Location[]): string {
  return locations
    .map((loc) => {
      const filePath = uriToPath(loc.uri);
      const { start } = loc.range;
      return `${filePath}:${start.line + 1}:${start.character + 1}`;
    })
    .join('\n');
}

export function textResult(text: string): ToolResult {
  return {
    content: [{ type: 'text', text }],
  };
}

export function withWarning(warning: string | undefined, text: string): string {
  return warning ? `${warning}\n\n${text}` : text;
}

export function rethrowToolOutcome(error: unknown): void {
  if (error instanceof LspToolOutcomeError) throw error;
}
