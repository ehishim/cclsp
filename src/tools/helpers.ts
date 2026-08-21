import { resolve } from 'node:path';
import { LspToolOutcomeError } from '../lsp/capabilities.js';
import type { Location } from '../lsp/types.js';
import { uriToPath } from '../utils.js';
import type { ToolResult } from './registry.js';

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
