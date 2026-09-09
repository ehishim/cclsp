import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LSPClient } from '../lsp-client.js';
import { LspToolOutcomeError } from '../lsp/capabilities.js';
import { spoolFullResult } from './helpers.js';

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>, client: LSPClient) => Promise<ToolResult>;
}

export type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
};

const DEFAULT_TOOL_RESULT_MAX_BYTES = 3 * 1024 * 1024;
const TOOL_RESULT_MAX_NODES = 100_000;
const TOOL_RESULT_PREVIEW_BYTES = 16 * 1024;

function resultByteLimit(): number {
  const configured = Number.parseInt(process.env.CCLSP_TOOL_RESULT_MAX_BYTES ?? '', 10);
  return Number.isInteger(configured) && configured > 0
    ? configured
    : DEFAULT_TOOL_RESULT_MAX_BYTES;
}

function jsonFits(value: unknown, maxBytes: number): boolean {
  const stack: unknown[] = [value];
  const seen = new WeakSet<object>();
  let bytes = 0;
  let nodes = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    nodes += 1;
    if (nodes > TOOL_RESULT_MAX_NODES) return false;
    if (current === null || current === undefined) {
      bytes += 4;
    } else if (typeof current === 'string') {
      bytes += Buffer.byteLength(JSON.stringify(current));
    } else if (typeof current === 'number' || typeof current === 'boolean') {
      bytes += String(current).length;
    } else if (typeof current === 'object') {
      if (seen.has(current)) return false;
      seen.add(current);
      if (Array.isArray(current)) {
        bytes += 2 + Math.max(0, current.length - 1);
        for (let index = current.length - 1; index >= 0; index -= 1) stack.push(current[index]);
      } else {
        const entries = Object.entries(current as Record<string, unknown>);
        bytes += 2 + Math.max(0, entries.length - 1);
        for (let index = entries.length - 1; index >= 0; index -= 1) {
          const [key, nested] = entries[index] ?? [];
          bytes += Buffer.byteLength(JSON.stringify(key)) + 1;
          stack.push(nested);
        }
      }
    }
    if (bytes > maxBytes) return false;
  }
  return true;
}

function headBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.byteLength <= maxBytes) return text;
  return buffer
    .subarray(0, maxBytes)
    .toString('utf8')
    .replace(/\uFFFD$/, '');
}

/** Scalar fields survive compaction; the bulk arrays live in the spool file. */
function scalarFields(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object') return {};
  const kept: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (nested === null || ['string', 'number', 'boolean'].includes(typeof nested)) {
      kept[key] = typeof nested === 'string' ? headBytes(nested, 1024) : nested;
    }
  }
  return kept;
}

/**
 * A result larger than the transport bound is never refused for volume: the
 * complete answer is written to a spool file and the caller receives a bounded
 * head plus that exact path, so nothing the provider produced is destroyed.
 */
export function boundToolResult(result: ToolResult, maxBytes = resultByteLimit()): ToolResult {
  if (jsonFits(result, maxBytes)) return result;
  const resultFile = spoolFullResult('tool_result', result);
  if (!resultFile) {
    return {
      content: [
        {
          type: 'text',
          text: 'TOOL_RESULT_SPOOL_FAILED: complete result could not be stored; restore writable result storage and retry.',
        },
      ],
      structuredContent: {
        outcome: 'unavailable',
        provider: 'none',
        code: 'TOOL_RESULT_SPOOL_FAILED',
      },
      isError: true,
    };
  }
  const scalars = scalarFields(result.structuredContent);
  const recovery = resultFile
    ? `Read the complete result at ${resultFile}, or narrow the file, symbol query, path, or result limit.`
    : 'Narrow the file, symbol query, path, or result limit and retry.';
  const head = headBytes(
    result.content.map((part) => part.text).join('\n'),
    TOOL_RESULT_PREVIEW_BYTES
  );
  return {
    content: [
      {
        type: 'text',
        text: `${head}\n\n... result bounded at ${maxBytes} bytes; complete result: ${resultFile ?? '(spool unavailable)'}`,
      },
    ],
    structuredContent: {
      ...scalars,
      outcome: typeof scalars.outcome === 'string' ? scalars.outcome : 'ok',
      provider: typeof scalars.provider === 'string' ? scalars.provider : 'none',
      bounded: true,
      recovery,
      ...(resultFile ? { resultFile } : {}),
    },
    ...(result.isError === true ? { isError: true } : {}),
  };
}

export function registerTools(server: Server, tools: ToolDefinition[], client: LSPClient): void {
  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description,
        inputSchema: t.inputSchema,
      })),
    };
  });

  const toolMap = new Map(tools.map((t) => [t.name, t]));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    try {
      const tool = toolMap.get(name);
      if (!tool) {
        throw new Error(`Unknown tool: ${name}`);
      }
      return boundToolResult(await tool.handler(args as Record<string, unknown>, client));
    } catch (error) {
      if (error instanceof LspToolOutcomeError) {
        return {
          content: [{ type: 'text' as const, text: `Error: ${error.message}` }],
          structuredContent: error.outcome,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error: ${error instanceof Error ? error.message : String(error)}`,
          },
        ],
        isError: true,
      };
    }
  });
}
