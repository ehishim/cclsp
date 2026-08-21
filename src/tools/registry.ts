import type { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import type { LSPClient } from '../lsp-client.js';
import { LspToolOutcomeError } from '../lsp/capabilities.js';

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
      return await tool.handler(args as Record<string, unknown>, client);
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
