import { existsSync } from 'node:fs';
import {
  WorkspaceEditConflictError,
  applyPreparedWorkspaceEdit,
  prepareWorkspaceEdit,
} from '../file-editor.js';
import type { LSPClient } from '../lsp-client.js';
import { uriToPath } from '../utils.js';
import { resolvePath, rethrowToolOutcome, textResult, withWarning } from './helpers.js';
import {
  positionResolutionResult,
  resolveToolPosition,
  resolvedFromMetadata,
  resolvedFromText,
} from './position-resolver.js';
import type { ToolDefinition } from './registry.js';
import {
  createSourcePreview,
  renderMutationCandidate,
  renderTextEditPreview,
} from './source-preview.js';

function matchKindText(
  match: { kind: number; resolutionSource?: string },
  client: LSPClient
): string {
  return match.resolutionSource === 'query-occurrence'
    ? 'query occurrence; semantic kind resolved by LSP'
    : client.symbolKindToString(match.kind);
}

export const renameSymbolTool: ToolDefinition = {
  name: 'rename_symbol',
  description:
    'Resolve one symbol by name and kind, then use the same candidate-bound preview/apply transaction as rename_symbol_strict.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file',
      },
      symbol_name: {
        type: 'string',
        description: 'The name of the symbol',
      },
      symbol_kind: {
        type: 'string',
        description: 'The kind of symbol (function, class, variable, method, etc.)',
      },
      new_name: {
        type: 'string',
        description: 'The new name for the symbol',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview by default; set false with candidate_id to apply',
      },
      candidate_id: {
        type: 'string',
        description: 'Opaque candidate identity returned by preview; required to apply',
      },
    },
    required: ['file_path', 'symbol_name', 'new_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      symbol_name,
      symbol_kind,
      new_name,
      dry_run = true,
      candidate_id,
    } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      new_name: string;
      dry_run?: boolean;
      candidate_id?: string;
    };
    const absolutePath = resolvePath(file_path);

    const result = await client.findSymbolsByName(absolutePath, symbol_name, symbol_kind);
    const { matches: symbolMatches, warning, incomplete } = result;

    if (incomplete) {
      return {
        content: [
          {
            type: 'text',
            text: withWarning(
              warning,
              `Refusing rename for "${symbol_name}": the bounded by-name query may omit another semantic target. Use rename_symbol_strict with an exact line and character.`
            ),
          },
        ],
        structuredContent: {
          outcome: 'rejected',
          code: 'LSP_SYMBOL_QUERY_INCOMPLETE',
          query: symbol_name,
          recovery: 'Use rename_symbol_strict with an exact line and character.',
        },
        isError: true,
      };
    }

    if (symbolMatches.length === 0) {
      return textResult(
        withWarning(
          warning,
          `No symbols found with name "${symbol_name}"${symbol_kind ? ` and kind "${symbol_kind}"` : ''} in ${file_path}. Please verify the symbol name and ensure the language server is properly configured.`
        )
      );
    }

    if (symbolMatches.length > 1) {
      const candidatesList = symbolMatches
        .map(
          (match) =>
            `- ${match.name} (${matchKindText(match, client)}) at line ${match.position.line + 1}, character ${match.position.character + 1}`
        )
        .join('\n');

      return textResult(
        withWarning(
          warning,
          `Multiple symbols found matching "${symbol_name}"${symbol_kind ? ` with kind "${symbol_kind}"` : ''}. Please use rename_symbol_strict with one of these positions:\n\n${candidatesList}`
        )
      );
    }

    // Single match - proceed with rename
    const match = symbolMatches[0];
    if (!match) {
      throw new Error('Unexpected error: no match found');
    }
    try {
      const rename = await renameSymbolStrictTool.handler(
        {
          file_path,
          line: match.position.line + 1,
          character: match.position.character + 1,
          new_name,
          dry_run,
          ...(candidate_id ? { candidate_id } : {}),
        },
        client
      );
      if (rename.content[0]?.type === 'text') {
        rename.content[0].text = withWarning(
          warning,
          `${match.name} (${matchKindText(match, client)})\n\n${rename.content[0].text}`
        );
      }
      return rename;
    } catch (error) {
      rethrowToolOutcome(error);
      return textResult(
        `Error renaming symbol: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const renameSymbolStrictTool: ToolDefinition = {
  name: 'rename_symbol_strict',
  description:
    'Rename a symbol by query or 1-indexed position after prepareRename. Applies by default; use dry_run to preview.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      query: { type: 'string', description: 'Symbol query (alternative to line/character)' },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
      new_name: { type: 'string', description: 'The new name for the symbol' },
      dry_run: {
        type: 'boolean',
        description: 'If true, only preview the changes without applying them (default: false)',
      },
      candidate_id: {
        type: 'string',
        description: 'Opaque candidate identity returned by dry_run; required to apply',
      },
    },
    required: ['file_path', 'new_name'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      query,
      line,
      character,
      new_name,
      dry_run = false,
      candidate_id,
    } = args as {
      file_path: string;
      query?: string;
      line?: number;
      character?: number;
      new_name: string;
      dry_run?: boolean;
      candidate_id?: string;
    };
    const absolutePath = resolvePath(file_path);
    const source = createSourcePreview(true);
    try {
      const resolution = await resolveToolPosition(
        absolutePath,
        { query, line, character },
        client
      );
      if (resolution.outcome !== 'resolved') {
        return positionResolutionResult(resolution, file_path);
      }
      const workspaceEdit = await client.renameSymbol(absolutePath, resolution.position, new_name, {
        allowUnpreparedPreview: dry_run,
      });
      const changes = workspaceEdit.changes ?? {};
      const resourceMoves = (workspaceEdit.resourceRenames ?? []).map((move) => ({
        oldPath: uriToPath(move.oldUri),
        newPath: uriToPath(move.newUri),
      }));
      const intent = JSON.stringify({
        operation: 'rename_symbol_strict',
        file: absolutePath,
        position: resolution.position,
        newName: new_name,
      });
      const editCount = Object.values(changes).reduce((total, edits) => total + edits.length, 0);
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      const preview: string[] = [];
      for (const [uri, edits] of Object.entries(changes)) {
        for (const edit of edits) {
          preview.push(renderTextEditPreview(source, uriToPath(uri), edit));
        }
      }
      if (dry_run && !workspaceEdit.prepared) {
        const warning =
          'The language server does not support textDocument/prepareRename. This preview may be document-scoped or incomplete; applying through cclsp remains refused.';
        const recovery =
          'Inspect the explicit edit set and independently prove its intended scope before applying edits through another authorized write path.';
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}${warning}\n\n[DRY RUN — PARTIAL] The server returned ${editCount} edit(s) for line ${resolution.position.line + 1}, character ${resolution.position.character + 1}:${preview.length > 0 ? `\n${preview.join('\n')}` : ' none.'}\n\nRecovery: ${recovery}`,
            },
          ],
          structuredContent: {
            outcome: 'partial',
            code: 'LSP_RENAME_UNPREPARED_PREVIEW',
            partial: true,
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            prepared: false,
            applied: false,
            edit: workspaceEdit,
            editCount,
            shown: editCount,
            total: editCount,
            omitted: 0,
            warning,
            recovery,
          },
          isError: true,
        };
      }
      if (Object.keys(changes).length === 0 && resourceMoves.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}No rename edits available at line ${resolution.position.line + 1}, character ${resolution.position.character + 1}. Please verify the symbol location and ensure the language server is properly configured.`,
            },
          ],
          structuredContent: {
            outcome: 'empty',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            prepared: workspaceEdit.prepared,
            applied: false,
            editCount: 0,
            shown: 0,
            total: 0,
            omitted: 0,
          },
        };
      }
      const preparedEdit = await prepareWorkspaceEdit(
        { changes },
        intent,
        [absolutePath],
        [],
        resourceMoves
      );
      if (dry_run) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}[DRY RUN]\n${renderMutationCandidate(preparedEdit.candidateId, 'Apply with the same file, selector, new name, and this candidate ID.')}\n\nWould rename symbol at line ${resolution.position.line + 1}, character ${resolution.position.character + 1} to "${new_name}":\n${preview.join('\n')}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            prepared: true,
            applied: false,
            edit: workspaceEdit,
            resourceMoves,
            candidateId: preparedEdit.candidateId,
            shown: editCount + resourceMoves.length,
            total: editCount + resourceMoves.length,
            omitted: 0,
          },
        };
      }
      if (!candidate_id) {
        return {
          content: [
            {
              type: 'text',
              text: 'LSP_RENAME_PREVIEW_REQUIRED: apply requires candidate_id from an inspected dry-run preview',
            },
          ],
          structuredContent: {
            outcome: 'rejected',
            code: 'LSP_RENAME_PREVIEW_REQUIRED',
            applied: false,
            candidateId: preparedEdit.candidateId,
          },
          isError: true,
        };
      }
      if (candidate_id !== preparedEdit.candidateId) {
        return {
          content: [
            {
              type: 'text',
              text: 'LSP_RENAME_STALE: rename edits or source bytes changed since preview',
            },
          ],
          structuredContent: {
            outcome: 'rejected',
            code: 'LSP_RENAME_STALE',
            applied: false,
            candidateId: preparedEdit.candidateId,
          },
          isError: true,
        };
      }
      const editResult = await applyPreparedWorkspaceEdit(preparedEdit, client);
      if (!editResult.success) {
        return {
          content: [{ type: 'text', text: `Failed to apply rename: ${editResult.error}` }],
          structuredContent: {
            outcome: 'rejected',
            code: editResult.error?.includes('changed')
              ? 'LSP_RENAME_STALE'
              : 'LSP_RENAME_APPLY_FAILED',
            applied: false,
            rollbackFailures: editResult.rollbackFailures ?? [],
          },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text',
            text: `${resolved ? `${resolved}\n\n` : ''}Successfully renamed symbol at line ${resolution.position.line + 1}, character ${resolution.position.character + 1} to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((file) => `- ${file}`).join('\n')}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          applied: true,
          candidateId: preparedEdit.candidateId,
          filesModified: editResult.filesModified,
          resourceMoves,
          shown: editCount + resourceMoves.length,
          total: editCount + resourceMoves.length,
          omitted: 0,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

interface FileMoveInput {
  old_path: string;
  new_path: string;
}

function validateFileMoveBatch(moves: FileMoveInput[]): string | null {
  if (moves.length < 1 || moves.length > 100) return 'moves must contain 1 to 100 file renames';
  const sources = new Set<string>();
  const destinations = new Set<string>();
  for (const move of moves) {
    if (!move.old_path || !move.new_path) return 'each move requires old_path and new_path';
    if (move.old_path === move.new_path)
      return `source and destination are identical: ${move.old_path}`;
    if (sources.has(move.old_path)) return `duplicate source: ${move.old_path}`;
    if (destinations.has(move.new_path)) return `duplicate destination: ${move.new_path}`;
    sources.add(move.old_path);
    destinations.add(move.new_path);
  }
  if ([...destinations].some((destination) => sources.has(destination))) {
    return 'rename cycles and destination/source chains are not supported in one batch';
  }
  return null;
}

export const renameFileTool: ToolDefinition = {
  name: 'rename_file',
  description:
    'Preview or atomically apply 1-100 file moves with one native willRenameFiles batch per language provider. Apply requires the candidate_id returned by preview.',
  inputSchema: {
    type: 'object',
    properties: {
      old_path: { type: 'string', description: 'Existing file path (single-move compatibility)' },
      new_path: {
        type: 'string',
        description: 'Destination file path (single-move compatibility)',
      },
      moves: {
        type: 'array',
        minItems: 1,
        maxItems: 100,
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            old_path: { type: 'string' },
            new_path: { type: 'string' },
          },
          required: ['old_path', 'new_path'],
        },
        description: 'Primary batch form: 1-100 file moves applied as one candidate',
      },
      dry_run: { type: 'boolean', description: 'Preview only (default true)' },
      candidate_id: {
        type: 'string',
        description: 'Opaque identity from preview; required when dry_run=false',
      },
    },
    oneOf: [{ required: ['old_path', 'new_path'] }, { required: ['moves'] }],
  },
  handler: async (args, client) => {
    const {
      old_path,
      new_path,
      dry_run = true,
      candidate_id,
      moves: rawMoves,
    } = args as {
      old_path?: string;
      new_path?: string;
      moves?: FileMoveInput[];
      dry_run?: boolean;
      candidate_id?: string;
    };
    const suppliedMoves = rawMoves ?? (old_path && new_path ? [{ old_path, new_path }] : []);
    const invalid = validateFileMoveBatch(suppliedMoves);
    if (invalid) return textResult(`Invalid file rename batch: ${invalid}`);
    const moves = suppliedMoves.map((move) => ({
      oldPath: resolvePath(move.old_path),
      newPath: resolvePath(move.new_path),
    }));
    for (const move of moves) {
      if (!existsSync(move.oldPath)) return textResult(`File does not exist: ${move.oldPath}`);
      if (existsSync(move.newPath))
        return textResult(`Destination already exists: ${move.newPath}`);
    }
    const firstMove = moves[0];
    if (!firstMove) return textResult('Invalid file rename batch: no moves');
    const source = createSourcePreview(true);
    try {
      const edit =
        typeof client.willRenameFilesBatch === 'function'
          ? await client.willRenameFilesBatch(moves)
          : await client.willRenameFiles(firstMove.oldPath, firstMove.newPath);
      const normalizedEdit = { changes: edit.changes ?? {} };
      const intent = JSON.stringify({ operation: 'rename_file', moves });
      const preparedEdit = await prepareWorkspaceEdit(
        normalizedEdit,
        intent,
        moves.map((move) => move.oldPath),
        moves.map((move) => move.newPath),
        moves
      );
      if (dry_run) {
        const editPreview = Object.entries(normalizedEdit.changes).flatMap(([uri, edits]) =>
          edits.map((edit) => renderTextEditPreview(source, uriToPath(uri), edit))
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `[DRY RUN]\n${renderMutationCandidate(preparedEdit.candidateId, 'Apply with the same moves and this candidate ID.')}\n\nWould rename ${moves.length} file(s) and apply:\n${moves.map((move) => `${move.oldPath} -> ${move.newPath}`).join('\n')}${editPreview.length > 0 ? `\n${editPreview.join('\n')}` : ''}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            applied: false,
            moves,
            candidateId: preparedEdit.candidateId,
            edit: normalizedEdit,
          },
        };
      }
      if (!candidate_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'LSP_FILE_RENAME_PREVIEW_REQUIRED: apply requires candidate_id from preview',
            },
          ],
          structuredContent: {
            outcome: 'rejected',
            code: 'LSP_FILE_RENAME_PREVIEW_REQUIRED',
            applied: false,
          },
          isError: true,
        };
      }
      if (candidate_id !== preparedEdit.candidateId) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'LSP_FILE_RENAME_STALE: file, import edits, or source bytes changed since preview',
            },
          ],
          structuredContent: { outcome: 'rejected', code: 'LSP_FILE_RENAME_STALE', applied: false },
          isError: true,
        };
      }
      const currentEdit =
        typeof client.willRenameFilesBatch === 'function'
          ? await client.willRenameFilesBatch(moves)
          : await client.willRenameFiles(firstMove.oldPath, firstMove.newPath);
      const currentPrepared = await prepareWorkspaceEdit(
        { changes: currentEdit.changes ?? {} },
        intent,
        moves.map((move) => move.oldPath),
        moves.map((move) => move.newPath),
        moves
      );
      if (currentPrepared.candidateId !== candidate_id) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'LSP_FILE_RENAME_STALE: file, import edits, or source bytes changed since preview',
            },
          ],
          structuredContent: { outcome: 'rejected', code: 'LSP_FILE_RENAME_STALE', applied: false },
          isError: true,
        };
      }
      const applied = await applyPreparedWorkspaceEdit(currentPrepared, client);
      if (!applied.success) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `File rename failed: ${applied.error ?? 'transaction failed'}`,
            },
          ],
          structuredContent: {
            outcome: 'rejected',
            code: applied.error?.includes('changed')
              ? 'LSP_FILE_RENAME_STALE'
              : 'LSP_FILE_RENAME_APPLY_FAILED',
            applied: false,
            rollbackFailures: applied.rollbackFailures ?? [],
          },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Renamed ${moves.length} file(s)${applied.filesModified.length > 0 ? ` and updated:\n${applied.filesModified.join('\n')}` : ''}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          applied: true,
          moves,
          candidateId: currentPrepared.candidateId,
          filesModified: applied.filesModified,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      if (error instanceof WorkspaceEditConflictError) {
        return {
          content: [{ type: 'text', text: `LSP_FILE_RENAME_CONFLICT: ${error.message}` }],
          structuredContent: {
            outcome: 'rejected',
            code: 'LSP_FILE_RENAME_CONFLICT',
            applied: false,
          },
          isError: true,
        };
      }
      throw error;
    }
  },
};

export const refactoringTools: ToolDefinition[] = [
  renameSymbolTool,
  renameSymbolStrictTool,
  renameFileTool,
];
