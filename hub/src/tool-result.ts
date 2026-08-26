// Canonical Hub projection that removes MCP transport and bounds source ranges.

const INDEX_DEPENDENT_TOOLS = new Set([
  'find_definition', 'find_references', 'find_workspace_symbols',
]);
const COLD_INDEX_WINDOW_MS = 5_000;

interface ToolResultEnvelope {
  content?: unknown;
  structuredContent?: unknown;
  isError?: boolean;
}

type NormalizedRange = {
  path: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
};

export function toolResultText(result: unknown): string {
  if (!result || typeof result !== 'object') return '';
  const direct = (result as { text?: unknown }).text;
  if (typeof direct === 'string') return direct;
  const envelope = result as ToolResultEnvelope;
  if (!Array.isArray(envelope.content)) return '';
  return envelope.content
    .map((content) => {
      if (content && typeof content === 'object'
        && (content as { type?: unknown }).type === 'text'
        && typeof (content as { text?: unknown }).text === 'string') {
        return (content as { text: string }).text;
      }
      return JSON.stringify(content);
    })
    .join('\n');
}

function sourcePath(value: unknown, inherited: string | null): string | null {
  if (typeof value !== 'string' || value.length === 0) return inherited;
  if (!value.startsWith('file://')) return value;
  try {
    return decodeURIComponent(new URL(value).pathname);
  } catch {
    return inherited;
  }
}

function collectRanges(
  value: unknown,
  inheritedPath: string | null,
  rows: NormalizedRange[],
  budget: { visited: number },
  depth = 0,
): void {
  if (depth > 8 || rows.length >= 1000 || budget.visited >= 10_000 || !value || typeof value !== 'object') return;
  budget.visited += 1;
  if (Array.isArray(value)) {
    for (const entry of value) collectRanges(entry, inheritedPath, rows, budget, depth + 1);
    return;
  }
  const shape = value as Record<string, unknown>;
  const path = sourcePath(shape.uri ?? shape.file ?? shape.file_path ?? shape.path, inheritedPath);
  const rangeValue = shape.range ?? shape.selectionRange;
  if (path && rangeValue && typeof rangeValue === 'object') {
    const range = rangeValue as {
      start?: { line?: unknown; character?: unknown };
      end?: { line?: unknown; character?: unknown };
    };
    const values = [range.start?.line, range.start?.character, range.end?.line, range.end?.character];
    if (values.every(Number.isInteger)) {
      rows.push({
        path,
        startLine: Number(range.start?.line) + 1,
        startCharacter: Number(range.start?.character) + 1,
        endLine: Number(range.end?.line) + 1,
        endCharacter: Number(range.end?.character) + 1,
      });
    }
  }
  for (const [key, nested] of Object.entries(shape)) {
    if (['range', 'selectionRange', 'uri', 'file', 'file_path', 'path'].includes(key)) continue;
    collectRanges(nested, path, rows, budget, depth + 1);
  }
}

function normalizedRanges(structured: Record<string, unknown>): NormalizedRange[] {
  const rows: NormalizedRange[] = [];
  collectRanges(structured, null, rows, { visited: 0 });
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = `${row.path}\u0000${row.startLine}\u0000${row.startCharacter}\u0000${row.endLine}\u0000${row.endCharacter}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resultCardinality(normalized: Record<string, unknown>, ranges: NormalizedRange[]): number {
  if (ranges.length > 0) return ranges.length;
  for (const key of ['symbols', 'locations', 'items', 'calls', 'diagnostics', 'actions', 'edits', 'matches', 'changes', 'signatures']) {
    const value = normalized[key];
    if (Array.isArray(value)) return value.length;
  }
  return 0;
}

/**
 * A project-wide answer produced while the server is still indexing is not just
 * possibly empty — it is possibly PARTIAL, and a partial answer that reports
 * `ok` with its own totals reads as complete. Measured on a cold root, one
 * reference query answered `1/1` and the same query answered `14/14` seconds
 * later. So every index-dependent answer inside the cold window is `stale`,
 * whatever it found; the rows are kept and the caller is told to re-ask.
 */
export function markColdIndexResult(
  result: unknown,
  toolName: string,
  rootAgeMs: number,
): unknown {
  if (!INDEX_DEPENDENT_TOOLS.has(toolName) || rootAgeMs >= COLD_INDEX_WINDOW_MS
    || !result || typeof result !== 'object') return result;
  const normalized = result as Record<string, unknown>;
  if (typeof normalized.outcome === 'string'
    && !['ok', 'empty'].includes(normalized.outcome)) return result;
  const recovery = normalized.outcome === 'empty'
    ? 'Retry the same call after the newly warmed root finishes indexing.'
    : 'This answer may be partial: retry the same call once the newly warmed root finishes indexing.';
  const text = typeof normalized.text === 'string' && normalized.text.length > 0
    ? `${normalized.text}\nHub: ${recovery}`
    : `Hub root is indexing. ${recovery}`;
  return {
    ...normalized,
    outcome: 'stale',
    code: 'HUB_ROOT_INDEXING',
    recovery,
    text,
  };
}

export function normalizeToolResult(
  result: unknown,
  options: { defaultProvider?: 'lsp' | 'tree-sitter' | 'none' } = {},
): unknown {
  if (!result || typeof result !== 'object') return result;
  const envelope = result as ToolResultEnvelope;
  const normalized: Record<string, unknown> = envelope.structuredContent
    && typeof envelope.structuredContent === 'object'
    ? { ...(envelope.structuredContent as Record<string, unknown>) }
    : {};
  const text = toolResultText(envelope);
  const ranges = normalizedRanges(normalized);
  const cardinality = resultCardinality(normalized, ranges);
  if (typeof normalized.outcome !== 'string') normalized.outcome = envelope.isError === true ? 'unavailable' : 'ok';
  if (typeof normalized.provider !== 'string') normalized.provider = options.defaultProvider ?? 'none';
  if (text) normalized.text = text;
  if (!Array.isArray(normalized.ranges) && ranges.length > 0) normalized.ranges = ranges;
  if (typeof normalized.shown !== 'number') normalized.shown = cardinality;
  if (typeof normalized.total !== 'number') normalized.total = cardinality;
  if (typeof normalized.omitted !== 'number') normalized.omitted = Math.max(0, Number(normalized.total) - Number(normalized.shown));
  if (envelope.isError === true) normalized.isError = true;
  return normalized;
}
