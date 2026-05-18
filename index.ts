#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { logger } from './src/logger.js';
import { LSPClient } from './src/lsp-client.js';
import { diagnosticsTools } from './src/tools/diagnostics.js';
import { hoverTools } from './src/tools/hover.js';
import { navigationTools } from './src/tools/navigation.js';
import { refactoringTools } from './src/tools/refactoring.js';
import { registerTools } from './src/tools/registry.js';
import { serverTools } from './src/tools/server.js';
import { symbolTools } from './src/tools/symbols.js';
import { VERSION } from './src/version.js';

// Handle subcommands
const args = process.argv.slice(2);
if (args.length > 0) {
  const subcommand = args[0];

  if (subcommand === 'setup') {
    const { main } = await import('./src/setup.js');
    await main();
    process.exit(0);
  } else {
    console.error(`Unknown subcommand: ${subcommand}`);
    console.error('Available subcommands:');
    console.error('  setup    Configure cclsp for your project');
    console.error('');
    console.error('Run without arguments to start the MCP server.');
    process.exit(1);
  }
}

const lspClient = new LSPClient();
let shuttingDown = false;

const server = new Server(
  {
    name: 'cclsp',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const allTools = [
  ...navigationTools,
  ...refactoringTools,
  ...diagnosticsTools,
  ...hoverTools,
  ...symbolTools,
  ...serverTools,
];

registerTools(server, allTools, lspClient);

async function shutdown(code = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    await lspClient.dispose();
  } finally {
    process.exit(code);
  }
}

process.on('SIGINT', () => {
  void shutdown(0);
});
process.on('SIGTERM', () => {
  void shutdown(0);
});
process.on('disconnect', () => {
  void shutdown(0);
});
process.stdin.on('end', () => {
  void shutdown(0);
});
process.stdin.on('close', () => {
  void shutdown(0);
});
process.stdin.on('error', () => {
  void shutdown(1);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  logger.info('CCLSP Server running on stdio\n');

  if (process.env.CCLSP_PRELOAD === '1') {
    // Preload LSP servers for file types found in the project when explicitly requested.
    try {
      await lspClient.preloadServers();
    } catch (error) {
      logger.error(`Failed to preload LSP servers: ${error}\n`);
    }
  } else {
    logger.info('Skipping LSP preload; servers will start on first tool call\n');
  }
}

main().catch((error) => {
  logger.error(`Server error: ${error}\n`);
  void shutdown(1);
});
