# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

cclsp is an MCP (Model Context Protocol) server that bridges Language Server Protocol (LSP) functionality to MCP tools. It allows MCP clients to access LSP features like "go to definition" and "find references" through a standardized interface.

## Development Commands

```bash
# Install dependencies
bun install

# Development with hot reload
bun run dev

# Build for production
bun run build

# Run the built server
bun run start
# or directly
node dist/index.js

# Run setup wizard to configure LSP servers
cclsp setup

# Quality assurance
bun run lint         # Check code style and issues
bun run lint:fix     # Auto-fix safe issues
bun run format       # Format code with Biome
bun run typecheck    # Run TypeScript type checking
bun run test         # Run unit tests
bun run test:manual  # Run manual MCP client test

# Full pre-publish check
npm run prepublishOnly  # build + test + typecheck
```

## Architecture

### Core Components

**MCP Server Layer** (`index.ts`)

- Entry point that implements MCP protocol
- Exposes `find_definition`, `find_references`, and `rename_symbol` tools
- Handles MCP client requests and delegates to LSP layer
- Includes subcommand handling for `cclsp setup`

**LSP Client Layer** (`src/lsp-client.ts`)

- Manages multiple LSP server processes concurrently
- Handles LSP protocol communication (JSON-RPC over stdio)
- Maps file extensions to appropriate language servers
- Maintains process lifecycle and request/response correlation
- Auto-detects and applies server-specific adapters

**AST Provider** (`src/ast/`)

- Loads installed Tree-sitter/WASM grammars for TypeScript/TSX, JavaScript/JSX, Python, PHP, Go, Rust, Java, and CSS without request-time downloads. `AST_LANGUAGE_DEFINITIONS` in `src/ast/types.ts` is the single owner of which grammar and which file extensions each language uses; the registry, the index and the tool schemas all derive from it. `.scss`/`.less` are deliberately unmapped: no grammar ships for them, and reading them as CSS would manufacture parse failures.
- Owns a root-contained, gitignore-aware index capped at 5,000 files and 512 KiB per file
- Uses Tree-sitter's error recovery as designed: a tree carrying parse errors is searched rather than discarded, so a grammar gap in one region never hides declarations that parsed correctly. Matches from such a file come back with `recovered: true` and the file is named `AST_PARSE_RECOVERED`; absence over that scope stays unproven
- Exposes structural patterns with `$NAME` single-node and `$$$NAME` variadic captures
- Builds root-bound structural rewrite previews and candidate identities; `file-editor.ts` owns exact-byte atomic commit/rollback and `LSPClient` owns strict provider synchronization
- Supplies explicitly syntax-only declaration, document-symbol, and query-position fallback when no configured LSP exists or the selected server does not support the required method
- Preserves provider provenance: an LSP answer that carries symbols remains `lsp`; AST results are `tree-sitter`; unavailable results are `none`. An LSP result of zero document symbols is not treated as an answer on its own, because a server that is still indexing returns exactly that without failing: Tree-sitter parses the one named file and settles it, and only replaces the empty list when it actually finds declarations. A file that genuinely declares nothing still answers empty as `lsp`.

**Server Adapter System** (`src/lsp/adapters/`)

- Built-in adapters for LSP servers with non-standard behavior
- Vue Language Server adapter handles custom `tsserver/request` protocol
- Pyright adapter provides extended timeouts for large projects
- Automatically detected based on server command (no configuration needed)
- Internal use only - not user-extensible

**Configuration System** (`cclsp.json` or via `CCLSP_CONFIG_PATH`)

- Defines which LSP servers to use for different file extensions
- Supports environment-based config via `CCLSP_CONFIG_PATH` env var
- Interactive setup wizard via `cclsp setup` command
- File scanning with gitignore support for project structure detection

### Data Flow

1. MCP client sends tool request (e.g., `find_definition`)
2. Main server resolves file path and extracts position
3. `LSPClient` remains the provider-selection owner: `ast_search` and syntax-only `code_rewrite` candidate construction go to its root-bound AST provider; semantic tools prefer the appropriate language server
4. `code_rewrite` defaults to preview; explicit apply recomputes the candidate under a lock, commits through the exact-byte file transaction, then synchronizes LSP documents/diagnostics and AST state or rolls all providers and disk back
5. If an admitted declaration/document-symbol operation has no configured server or the method is unsupported, `LSPClient` may return a syntax-only Tree-sitter fallback with explicit limitations. A zero-symbol document-symbol result is also settled by Tree-sitter, since a still-indexing server produces it without failing and every caller reads it as a fact about the file; resolution by name (`find_references`, `find_definition`, `rename_symbol`) goes through that same settled set, so no by-name caller inherits an unfinished index. Other LSP failures still never fall back.
6. If an LSP server is needed and not running, spawns the language server process
7. Sends the request to the selected provider and transforms the result back to MCP format with explicit provider provenance

### LSP Server Management

The system spawns separate LSP server processes per configuration. Each server:

- Runs as child process with stdio communication
- Maintains its own initialization state
- Handles multiple concurrent requests
- Gets terminated on process exit

Supported language servers (configurable):

- TypeScript: `typescript-language-server`
- Python: `pylsp`
- Go: `gopls`

## Configuration

The server loads configuration in this order:

1. `CCLSP_CONFIG_PATH` environment variable pointing to config file
2. `cclsp.json` file in working directory
3. Fails if neither is found (no default fallback)

### Interactive Setup

Use `cclsp setup` to configure LSP servers interactively:

- Scans project for file extensions (respects .gitignore)
- Presents pre-configured language server options
- Generates `cclsp.json` configuration file
- Validates server availability before configuration

Each server config requires:

- `extensions`: File extensions to handle (array)
- `command`: Command array to spawn LSP server
- `rootDir`: Working directory for LSP server (optional)
- `restartInterval`: Auto-restart interval in minutes (optional, helps with long-running server stability, minimum 1 minute)

### Example Configuration

```json
{
  "servers": [
    {
      "extensions": ["py"],
      "command": ["pylsp"],
      "restartInterval": 5
    },
    {
      "extensions": ["ts", "tsx", "js", "jsx"],
      "command": ["typescript-language-server", "--stdio"],
      "restartInterval": 10
    }
  ]
}
```

## Code Quality & Testing

The project uses Biome for linting and formatting:

- **Linting**: Enabled with recommended rules + custom strictness
- **Formatting**: 2-space indents, single quotes, semicolons always, LF endings
- **TypeScript**: Strict type checking with `--noEmit`
- **Testing**: Bun test framework with unit tests in `src/*.test.ts`

Run quality checks before committing:

```bash
bun run lint:fix && bun run format && bun run typecheck && bun run test
```

## Structural AST Search

`ast_search(pattern, language, path?, max_results?)` is an offline structural-search tool. `language` is required. A relative `path` resolves under the registered root, and canonical path checks reject traversal or symlink escape. `max_results` defaults to 100 and is capped at 1,000.

Use `$NAME` for one named syntax node and `$$$NAME` for zero or more named siblings. Structured ranges are zero-indexed; default text coordinates are one-indexed. Invalid patterns, unsupported languages, invalid/escaped paths, and explicit oversized files are typed `AST_*` rejections, and an explicitly named unparseable file is still `AST_PARSE_FAILED`. In a directory scan a file the parser could only recover is searched instead of skipped: its matches are returned as `recovered` presence evidence, the file is listed as `AST_PARSE_RECOVERED`, and the result stays `partial` so no zero over that scope is read as absence. Directory searches expose skipped-file, index-cap, truncation, and partial-parse metadata.

Tree-sitter evidence is syntax-only. Never use it as semantic proof for references, inferred types, signatures, implementations, call hierarchy, diagnostics, or rename safety.

## Structural Rewrite

`code_rewrite(pattern, replacement, language, path?, dry_run=true, candidate_id?)` reuses the structural matcher. Preview first; apply only with `dry_run=false` and the unchanged opaque candidate ID. Rewrites are root-contained, Git-clean, UTF-8, generated/ignore excluding, overlap rejecting, parse validating, capped at 100 changes/512 KiB per output/16 MiB per transaction, and atomic across disk plus live providers. Rollback reports disk and provider restoration separately and leaves no partial-success result.

Use `ast_search` before rewrite. Use prepare-first LSP `rename_symbol_strict` for identifier/symbol renames; structural rewrite deliberately rejects identifier-only rename shapes and makes no semantic reference/import safety claim.

## LSP Protocol Details

The implementation handles LSP protocol specifics:

- Content-Length headers for message framing
- JSON-RPC 2.0 message format
- Request/response correlation via ID tracking
- Server initialization handshake
- Proper process cleanup on shutdown
- Preloading of servers for detected file types
- Automatic server restart based on configured intervals
- Manual server restart via MCP tool
- Server-specific adapters for non-standard protocol extensions

### Server Adapters

Some LSP servers deviate from the standard protocol or have special requirements. cclsp includes built-in adapters to handle these cases automatically:

#### Vue Language Server Adapter

The Vue Language Server uses a non-standard `tsserver/request` protocol for TypeScript integration. The adapter:

- Handles `tsserver/request` notifications from the server
- Responds with minimal project information to unblock the server
- Extends timeouts for operations requiring TypeScript analysis (60s for documentSymbol, 45s for definition/references/rename)
- Automatically detected when command contains `vue-language-server` or `@vue/language-server`

#### Pyright Adapter

Pyright can be slow on large Python projects. The adapter:

- Extends timeouts for operations that may analyze many files (45-60s)
- Automatically detected when command contains `pyright` or `basedpyright`

**Note**: Adapters are internal to cclsp and not user-extensible. They are automatically selected based on the server command - no configuration needed.
