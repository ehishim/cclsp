import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { applyWorkspaceEdit } from '../file-editor.js';
import type { LSPClient } from '../lsp-client.js';
import { pathToUri, uriToPath } from '../utils.js';
import { resolvePath, rethrowToolOutcome, textResult, withWarning } from './helpers.js';
import {
  positionResolutionResult,
  resolveToolPosition,
  resolvedFromMetadata,
  resolvedFromText,
} from './position-resolver.js';
import type { ToolDefinition } from './registry.js';

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
    'Rename a symbol by name and kind in a file. If multiple symbols match, returns candidate positions and suggests using rename_symbol_strict. By default, this will apply the rename to the files. Use dry_run to preview changes without applying them.',
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
        description: 'If true, only preview the changes without applying them (default: false)',
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
      dry_run = false,
    } = args as {
      file_path: string;
      symbol_name: string;
      symbol_kind?: string;
      new_name: string;
      dry_run?: boolean;
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
      const workspaceEdit = await client.renameSymbol(absolutePath, match.position, new_name);

      if (workspaceEdit?.changes && Object.keys(workspaceEdit.changes).length > 0) {
        const changes = [];
        for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
          const filePath = uriToPath(uri);
          changes.push(`File: ${filePath}`);
          for (const edit of edits) {
            const { start, end } = edit.range;
            changes.push(
              `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
            );
          }
        }

        // Apply changes if not in dry run mode
        if (!dry_run) {
          const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient: client });

          if (!editResult.success) {
            return textResult(`Failed to apply rename: ${editResult.error}`);
          }

          return textResult(
            withWarning(
              warning,
              `Successfully renamed ${match.name} (${matchKindText(match, client)}) to "${new_name}".\n\nModified files:\n${editResult.filesModified.map((f) => `- ${f}`).join('\n')}`
            )
          );
        }
        // Dry run mode - show preview
        return textResult(
          withWarning(
            warning,
            `[DRY RUN] Would rename ${match.name} (${matchKindText(match, client)}) to "${new_name}":\n${changes.join('\n')}`
          )
        );
      }
      return textResult(
        withWarning(
          warning,
          `No rename edits available for ${match.name} (${matchKindText(match, client)}). The symbol may not be renameable or the language server doesn't support renaming this type of symbol.`
        )
      );
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
    } = args as {
      file_path: string;
      query?: string;
      line?: number;
      character?: number;
      new_name: string;
      dry_run?: boolean;
    };
    const absolutePath = resolvePath(file_path);
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
      const editCount = Object.values(changes).reduce((total, edits) => total + edits.length, 0);
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      const preview: string[] = [];
      for (const [uri, edits] of Object.entries(changes)) {
        preview.push(`File: ${uriToPath(uri)}`);
        for (const edit of edits) {
          const { start, end } = edit.range;
          preview.push(
            `  - Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}: "${edit.newText}"`
          );
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
      if (Object.keys(changes).length === 0) {
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
      if (dry_run) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}[DRY RUN] Would rename symbol at line ${resolution.position.line + 1}, character ${resolution.position.character + 1} to "${new_name}":\n${preview.join('\n')}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            prepared: true,
            applied: false,
            edit: workspaceEdit,
            shown: editCount,
            total: editCount,
            omitted: 0,
          },
        };
      }
      const editResult = await applyWorkspaceEdit(workspaceEdit, { lspClient: client });
      if (!editResult.success) return textResult(`Failed to apply rename: ${editResult.error}`);
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
          filesModified: editResult.filesModified,
          shown: editCount,
          total: editCount,
          omitted: 0,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const renameFileTool: ToolDefinition = {
  name: 'rename_file',
  description:
    'Rename a file with language-server willRenameFiles import edits, then notify didRenameFiles. Defaults to dry-run.',
  inputSchema: {
    type: 'object',
    properties: {
      old_path: { type: 'string', description: 'Existing file path' },
      new_path: { type: 'string', description: 'Destination file path' },
      dry_run: { type: 'boolean', description: 'Preview only (default true)' },
    },
    required: ['old_path', 'new_path'],
  },
  handler: async (args, client) => {
    const {
      old_path,
      new_path,
      dry_run = true,
    } = args as {
      old_path: string;
      new_path: string;
      dry_run?: boolean;
    };
    const oldPath = resolvePath(old_path);
    const newPath = resolvePath(new_path);
    if (!existsSync(oldPath)) return textResult(`File does not exist: ${oldPath}`);
    if (existsSync(newPath)) return textResult(`Destination already exists: ${newPath}`);
    try {
      const edit = await client.willRenameFiles(oldPath, newPath);
      const oldUri = pathToUri(oldPath);
      const newUri = pathToUri(newPath);
      const normalizedChanges = { ...(edit.changes ?? {}) };
      if (normalizedChanges[oldUri]) {
        normalizedChanges[newUri] = [
          ...(normalizedChanges[newUri] ?? []),
          ...normalizedChanges[oldUri],
        ];
        delete normalizedChanges[oldUri];
      }
      const normalizedEdit = { changes: normalizedChanges };
      if (dry_run) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `[DRY RUN] Would rename ${oldPath} to ${newPath} and apply:\n${JSON.stringify(normalizedChanges, null, 2)}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            applied: false,
            oldPath,
            newPath,
            edit: normalizedEdit,
          },
        };
      }
      return await client.withDocumentWriteScopes(
        [oldPath, ...Object.keys(edit.changes ?? {}).map(uriToPath)],
        async () => {
          if (!existsSync(oldPath) || existsSync(newPath))
            throw new Error('File rename target changed before apply');
          const currentEdit = await client.willRenameFiles(oldPath, newPath);
          if (JSON.stringify(currentEdit) !== JSON.stringify(edit))
            throw new Error('File rename edits changed before apply; preview again');
          const originals = new Map(
            Object.keys(edit.changes ?? {}).map((uri) => {
              const path = uriToPath(uri);
              return [path, readFileSync(path)] as const;
            })
          );
          let moved = false;
          let applied: Awaited<ReturnType<typeof applyWorkspaceEdit>>;
          try {
            applied = await applyWorkspaceEdit(edit, { createBackups: false });
            if (!applied.success) throw new Error(applied.error ?? 'failed to update imports');
            renameSync(oldPath, newPath);
            moved = true;
            await client.didRenameFiles(oldPath, newPath);
            for (const path of applied.filesModified)
              await client.syncFileContent(path === oldPath ? newPath : path);
          } catch (error) {
            const failures: string[] = [];
            if (moved) {
              try {
                renameSync(newPath, oldPath);
              } catch {
                failures.push('rename');
              }
            }
            for (const [path, bytes] of originals) {
              try {
                writeFileSync(path, bytes);
              } catch {
                failures.push(path);
              }
            }
            if (moved && !failures.includes('rename')) {
              try {
                await client.didRenameFiles(newPath, oldPath);
              } catch {
                failures.push('documents');
              }
            }
            for (const path of originals.keys()) {
              try {
                await client.syncFileContent(path);
              } catch {
                failures.push(`sync:${path}`);
              }
            }
            return {
              content: [
                {
                  type: 'text' as const,
                  text: `File rename failed: ${String(error)}; rollback ${failures.length ? 'incomplete' : 'complete'}`,
                },
              ],
              structuredContent: {
                outcome: 'rejected',
                code: 'LSP_ACTION_NOT_APPLICABLE',
                rolledBack: failures.length === 0,
                rollbackFailures: failures,
              },
              isError: true,
            };
          }
          return {
            content: [
              {
                type: 'text' as const,
                text: `Renamed ${oldPath} to ${newPath}${applied.filesModified.length > 0 ? ` and updated:\n${applied.filesModified.join('\n')}` : ''}`,
              },
            ],
            structuredContent: {
              outcome: 'ok',
              applied: true,
              oldPath,
              newPath,
              filesModified: applied.filesModified,
            },
          };
        }
      );
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const refactoringTools: ToolDefinition[] = [
  renameSymbolTool,
  renameSymbolStrictTool,
  renameFileTool,
];
