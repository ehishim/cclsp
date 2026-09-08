// Canonical Hub projection that removes MCP transport and bounds source ranges.

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

function normalizedRanges(structured: Record<string, unknown>): NormalizedRange[] {
  const rows: NormalizedRange[] = [];
  const stack: Array<{ value: unknown; inheritedPath: string | null }> = [
    { value: structured, inheritedPath: null },
  ];
  const visited = new WeakSet<object>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current?.value || typeof current.value !== 'object' || visited.has(current.value)) continue;
    visited.add(current.value);
    if (Array.isArray(current.value)) {
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({ value: current.value[index], inheritedPath: current.inheritedPath });
      }
      continue;
    }
    const shape = current.value as Record<string, unknown>;
    const path = sourcePath(
      shape.uri ?? shape.file ?? shape.file_path ?? shape.path,
      current.inheritedPath,
    );
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
    const entries = Object.entries(shape);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const entry = entries[index];
      if (!entry) continue;
      const [key, nested] = entry;
      if (['range', 'selectionRange', 'uri', 'file', 'file_path', 'path'].includes(key)) continue;
      stack.push({ value: nested, inheritedPath: path });
    }
  }
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
  if (normalized.outcome !== 'partial' && normalized.total !== null && typeof normalized.total !== 'number') {
    normalized.total = cardinality;
  }
  if (typeof normalized.total === 'number' && typeof normalized.omitted !== 'number') {
    normalized.omitted = Math.max(0, normalized.total - Number(normalized.shown));
  }
  if (envelope.isError === true) normalized.isError = true;
  return normalized;
}
