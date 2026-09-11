/** One owner for read-only tools that accept one symbol name or several. */

export const NAMED_QUERY_SCHEMA = {
  anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
} as const;

/**
 * Preserve asked order and duplicates: collapsing either changes per-name
 * attribution and how the shared row bound is spent. No artificial name-count
 * ceiling; the output row/byte limits are the real bounds.
 */
export function normalizeNamedQueries(value: unknown, field = 'query'): string[] {
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length === 0) throw new Error(`${field} must name at least one symbol`);
  const queries: string[] = [];
  for (const entry of entries) {
    if (typeof entry !== 'string' || entry.trim().length === 0) {
      throw new Error(`every ${field} entry must be a non-empty string`);
    }
    queries.push(entry.trim());
  }
  return queries;
}

export function normalizeNamedQuerySelector(
  value: unknown,
  line: unknown,
  character: unknown,
  field = 'query'
): string[] | null {
  if (value === undefined) return null;
  if (line !== undefined || character !== undefined) {
    throw new Error(`provide ${field} or line/character, not both`);
  }
  return normalizeNamedQueries(value, field);
}

export function namedQueryOutcome(resolution: string, total: number, shown: number): string {
  if (resolution === 'not_found') return 'empty';
  if (resolution !== 'resolved') return resolution;
  if (total > 0 && shown === 0) return 'partial';
  return shown > 0 ? 'ok' : 'empty';
}

export function namedQueryResolutionFailed(resolution: string): boolean {
  return !['resolved', 'not_found'].includes(resolution);
}

export interface NamedRows<T, M extends object = Record<string, never>> {
  query: string;
  rows: T[];
  metadata: M;
}

/** Spend one shared row limit in asked order; a later name is omitted, never a false zero. */
export function boundNamedRows<T, M extends object>(
  answers: Array<NamedRows<T, M>>,
  limit: number
): {
  rows: T[];
  total: number;
  omitted: number;
  perQuery: Array<
    M & {
      query: string;
      rows: T[];
      shown: number;
      total: number;
      omitted: number;
    }
  >;
} {
  let remaining = limit;
  const perQuery = answers.map((answer) => {
    const rows = answer.rows.slice(0, Math.max(remaining, 0));
    remaining -= rows.length;
    return {
      ...answer.metadata,
      query: answer.query,
      rows,
      shown: rows.length,
      total: answer.rows.length,
      omitted: answer.rows.length - rows.length,
    };
  });
  const rows = perQuery.flatMap((answer) => answer.rows);
  const total = answers.reduce((sum, answer) => sum + answer.rows.length, 0);
  return { rows, total, omitted: total - rows.length, perQuery };
}
