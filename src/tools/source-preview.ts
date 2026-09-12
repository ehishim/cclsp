/** One owner for the source window every location-producing tool shares. */
import { readFileSync } from 'node:fs';

/**
 * A location row alone says only WHERE a name the caller already knew is, so
 * choosing between candidates costs one file read each -- and the read is the
 * expensive part, not the row. A window around the line answers overload,
 * re-export, type versus value and real versus test double inside the same
 * answer. Two lines is the default because a signature that wraps is the common
 * case and anything wider starts paying for context nobody reads.
 */
export const PREVIEW_DEFAULT_CONTEXT = 2;
export const PREVIEW_MAX_CONTEXT = 20;
const PREVIEW_MAX_CHARS = 200;

export type PreviewOption = boolean | number | undefined;

export type SourceReader = (file: string) => string;

export interface SourcePreview {
  context: number;
  /** Read each file once: a hundred references commonly land in a handful of files. */
  cache: Map<string, string[] | null>;
  /** Injectable so a test can COUNT reads instead of asserting that it counted them. */
  read: SourceReader;
}

const defaultReader: SourceReader = (file) => readFileSync(file, 'utf8');

/**
 * `false`/`0` disables; `true` or omission takes the default window; a number sets
 * it exactly. Call this at handler entry, BEFORE any provider request: an invalid
 * width must cost nothing, and a refusal issued after the call has already spent
 * the expensive part of the answer.
 */
export function createSourcePreview(
  value: PreviewOption,
  read: SourceReader = defaultReader
): SourcePreview | null {
  if (value === false) return null;
  let context = PREVIEW_DEFAULT_CONTEXT;
  if (value !== undefined && value !== true) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error(`preview must be a boolean or an integer from 0 to ${PREVIEW_MAX_CONTEXT}`);
    }
    if (value > PREVIEW_MAX_CONTEXT) {
      throw new Error(`preview context is at most ${PREVIEW_MAX_CONTEXT} lines`);
    }
    context = value;
  }
  return context === 0 ? null : { context, cache: new Map(), read };
}

export const PREVIEW_SCHEMA = {
  anyOf: [{ type: 'boolean' }, { type: 'number' }],
  description: `Source window around each row, numbered, with the matched line marked (default ${PREVIEW_DEFAULT_CONTEXT} lines of context; false or 0 for positions only; max ${PREVIEW_MAX_CONTEXT}). It answers which candidate is the right one without a second read.`,
} as const;

function clip(text: string): string {
  return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

function fileLines(preview: SourcePreview, file: string): string[] | null {
  const cache = preview.cache;
  let lines = cache.get(file);
  if (lines === undefined) {
    try {
      lines = preview.read(file).split('\n');
    } catch {
      // A row whose file cannot be read is still a real answer; only its preview
      // is missing, and dropping the row with it would turn a match into silence.
      lines = null;
    }
    cache.set(file, lines);
  }
  return lines;
}

/**
 * Numbered so a caller can cite or re-read an exact line without recounting, and
 * span-aware so a multi-line match renders through this one owner too rather than
 * growing a second rendering that drifts from it.
 */
export function previewSpan(
  preview: SourcePreview | null,
  file: string,
  firstMatchedLine: number,
  lastMatchedLine = firstMatchedLine
): string[] {
  if (!preview) return [];
  const lines = fileLines(preview, file);
  if (!lines) return [];
  const first = Math.max(firstMatchedLine - preview.context, 0);
  const last = Math.min(lastMatchedLine + preview.context, lines.length - 1);
  const rows: string[] = [];
  for (let index = first; index <= last; index += 1) {
    const text = lines[index] ?? '';
    // grep/ripgrep convention: `:` marks a matched line, `-` marks context. It
    // needs no legend, it matches the `path:line:col` head above it, and it avoids
    // `>`, which already means a diff, a quote or a prompt everywhere else.
    // Contiguous on purpose, blank lines included: skipping one saves nothing
    // measurable and turns the numbering into a gap a reader has to explain.
    const matched = index >= firstMatchedLine && index <= lastMatchedLine;
    rows.push(`  ${index + 1}${matched ? ':' : '-'} ${clip(text)}`);
  }
  return rows;
}

export function previewWindow(
  preview: SourcePreview | null,
  file: string,
  zeroBasedLine: number
): string[] {
  return previewSpan(preview, file, zeroBasedLine);
}

export function renderMutationCandidate(candidateId: string, instruction: string): string {
  return `Candidate ID: ${candidateId}\n${instruction}`;
}

export function renderTextEditPreview(
  preview: SourcePreview | null,
  file: string,
  edit: {
    range: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
    newText: string;
  }
): string {
  const { start, end } = edit.range;
  return [
    `File: ${file} · Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: ${JSON.stringify(edit.newText)}`,
    ...previewSpan(preview, file, start.line, end.line),
  ].join('\n');
}

/** One location row, optionally followed by its window. Coordinates are 1-indexed. */
export function renderLocationRow(
  preview: SourcePreview | null,
  location: { file: string; zeroBasedLine: number; zeroBasedCharacter: number; suffix?: string }
): string {
  const head = `${location.file}:${location.zeroBasedLine + 1}:${location.zeroBasedCharacter + 1}${location.suffix ?? ''}`;
  const window = previewWindow(preview, location.file, location.zeroBasedLine);
  return window.length ? [head, ...window].join('\n') : head;
}
