import { applyWorkspaceEdit } from '../file-editor.js';
import type { TextDocumentEditResult, WorkspaceEditResult } from '../lsp/operations.js';
import { resolvePath, rethrowToolOutcome, textResult } from './helpers.js';
import type { ToolDefinition, ToolResult } from './registry.js';

function normalizeTextWorkspaceEdit(edit: WorkspaceEditResult): {
  edit?: Pick<WorkspaceEditResult, 'changes'>;
  reason?: string;
} {
  const changes = Object.fromEntries(
    Object.entries(edit.changes ?? {}).map(([uri, edits]) => [uri, [...edits]])
  );
  for (const change of edit.documentChanges ?? []) {
    if (!change || typeof change !== 'object' || Array.isArray(change)) {
      return { reason: 'the WorkspaceEdit contains an invalid documentChanges entry' };
    }
    if ('kind' in change) {
      const kind = String((change as { kind?: unknown }).kind ?? 'unknown');
      return { reason: `the WorkspaceEdit contains unsupported resource operation "${kind}"` };
    }
    if (!('textDocument' in change) || !('edits' in change)) {
      return { reason: 'the WorkspaceEdit contains an unsupported documentChanges entry' };
    }
    const textChange = change as TextDocumentEditResult;
    if (
      !textChange.textDocument ||
      typeof textChange.textDocument.uri !== 'string' ||
      !Array.isArray(textChange.edits)
    ) {
      return { reason: 'the WorkspaceEdit contains an invalid TextDocumentEdit' };
    }
    changes[textChange.textDocument.uri] = [
      ...(changes[textChange.textDocument.uri] ?? []),
      ...textChange.edits,
    ];
  }
  return { edit: { changes } };
}

function rejectedResult(method: string, reason: string): ToolResult {
  return {
    content: [{ type: 'text', text: `Error: LSP_ACTION_NOT_APPLICABLE: ${reason}` }],
    structuredContent: {
      outcome: 'rejected',
      code: 'LSP_ACTION_NOT_APPLICABLE',
      method,
      reason,
    },
    isError: true,
  };
}

export const getCompletionsTool: ToolDefinition = {
  name: 'get_completions',
  description:
    'Get language-server completions at a position. Results are bounded by limit (default 50, maximum 100).',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
      trigger_character: { type: 'string', description: 'Optional completion trigger character' },
      limit: { type: 'number', description: 'Maximum items to return (default 50, max 100)' },
    },
    required: ['file_path', 'line', 'character'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      line,
      character,
      trigger_character,
      limit = 50,
    } = args as {
      file_path: string;
      line: number;
      character: number;
      trigger_character?: string;
      limit?: number;
    };
    const boundedLimit = Math.max(1, Math.min(100, Math.trunc(limit)));
    try {
      const result = await client.getCompletions(
        resolvePath(file_path),
        { line: line - 1, character: character - 1 },
        trigger_character
      );
      const items = result.items.slice(0, boundedLimit).map((item) => ({
        label: item.label,
        ...(item.kind !== undefined ? { kind: item.kind } : {}),
        ...(item.detail ? { detail: item.detail } : {}),
        ...(item.insertText ? { insertText: item.insertText } : {}),
      }));
      return {
        content: [
          {
            type: 'text' as const,
            text:
              items.length === 0
                ? `No completions found at ${file_path}:${line}:${character}`
                : `Completions at ${file_path}:${line}:${character}:\n${JSON.stringify(items, null, 2)}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          items,
          isIncomplete: result.isIncomplete,
          truncated: result.items.length > items.length,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const getSignatureHelpTool: ToolDefinition = {
  name: 'get_signature_help',
  description: 'Get signature and parameter help at a position.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
      trigger_character: { type: 'string', description: 'Optional signature trigger character' },
    },
    required: ['file_path', 'line', 'character'],
  },
  handler: async (args, client) => {
    const { file_path, line, character, trigger_character } = args as {
      file_path: string;
      line: number;
      character: number;
      trigger_character?: string;
    };
    try {
      const result = await client.getSignatureHelp(
        resolvePath(file_path),
        { line: line - 1, character: character - 1 },
        trigger_character
      );
      if (!result || result.signatures.length === 0) {
        return textResult(`No signature help available at ${file_path}:${line}:${character}`);
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Signature help at ${file_path}:${line}:${character}:\n${JSON.stringify(result, null, 2)}`,
          },
        ],
        structuredContent: { outcome: 'ok', ...result },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const getCodeActionsTool: ToolDefinition = {
  name: 'get_code_actions',
  description:
    'List language-server code actions for a range, or select one exact title to preview/apply its WorkspaceEdit. Arbitrary server commands are never executed.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      start_line: { type: 'number', description: 'Range start line (1-indexed)' },
      start_character: { type: 'number', description: 'Range start character (1-indexed)' },
      end_line: { type: 'number', description: 'Range end line (1-indexed)' },
      end_character: { type: 'number', description: 'Range end character (1-indexed)' },
      title: { type: 'string', description: 'Exact action title to select' },
      apply: { type: 'boolean', description: 'Apply the selected WorkspaceEdit (default false)' },
    },
    required: ['file_path', 'start_line', 'start_character', 'end_line', 'end_character'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      start_line,
      start_character,
      end_line,
      end_character,
      title,
      apply = false,
    } = args as {
      file_path: string;
      start_line: number;
      start_character: number;
      end_line: number;
      end_character: number;
      title?: string;
      apply?: boolean;
    };
    const absolutePath = resolvePath(file_path);
    try {
      const actions = await client.getCodeActions(absolutePath, {
        start: { line: start_line - 1, character: start_character - 1 },
        end: { line: end_line - 1, character: end_character - 1 },
      });
      const summaries = actions.map((action, index) => ({
        index,
        title: action.title,
        ...(action.kind ? { kind: action.kind } : {}),
        ...(action.isPreferred !== undefined ? { isPreferred: action.isPreferred } : {}),
        ...(action.disabled ? { disabled: action.disabled.reason } : {}),
        hasEdit: !!action.edit,
        commandOnly: !!action.command && !action.edit,
      }));
      if (!title) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                summaries.length === 0
                  ? `No code actions found for ${file_path}`
                  : `Code actions for ${file_path}:\n${JSON.stringify(summaries, null, 2)}`,
            },
          ],
          structuredContent: { outcome: 'ok', actions: summaries },
        };
      }
      const matches = actions.filter((action) => action.title === title);
      if (matches.length !== 1) {
        return rejectedResult(
          'textDocument/codeAction',
          matches.length === 0
            ? `no action has the exact title "${title}"`
            : `${matches.length} actions have the title "${title}"`
        );
      }
      const matchedAction = matches[0];
      if (!matchedAction) {
        return rejectedResult(
          'textDocument/codeAction',
          `no action has the exact title "${title}"`
        );
      }
      const selected = await client.resolveCodeAction(absolutePath, matchedAction);
      if (selected.disabled) {
        return rejectedResult('textDocument/codeAction', selected.disabled.reason);
      }
      if (!selected.edit) {
        return rejectedResult(
          'textDocument/codeAction',
          selected.command
            ? 'the action requires workspace/executeCommand, which cclsp does not execute'
            : 'the action did not provide a WorkspaceEdit'
        );
      }
      const normalized = normalizeTextWorkspaceEdit(selected.edit);
      if (normalized.reason) {
        return rejectedResult('textDocument/codeAction', normalized.reason);
      }
      const normalizedEdit = normalized.edit;
      if (!normalizedEdit?.changes || Object.keys(normalizedEdit.changes).length === 0) {
        return rejectedResult('textDocument/codeAction', 'the action did not provide text edits');
      }
      if (!apply) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `[DRY RUN] Code action "${title}" would apply:\n${JSON.stringify(normalizedEdit.changes, null, 2)}`,
            },
          ],
          structuredContent: { outcome: 'ok', applied: false, title, edit: normalizedEdit },
        };
      }
      const applied = await applyWorkspaceEdit(normalizedEdit, { lspClient: client });
      if (!applied.success) {
        return rejectedResult('textDocument/codeAction', applied.error ?? 'failed to apply edit');
      }
      return {
        content: [
          {
            type: 'text' as const,
            text: `Applied code action "${title}" to ${applied.filesModified.length} file(s):\n${applied.filesModified.join('\n')}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          applied: true,
          title,
          filesModified: applied.filesModified,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

export const languageFeatureTools: ToolDefinition[] = [
  getCompletionsTool,
  getSignatureHelpTool,
  getCodeActionsTool,
];
