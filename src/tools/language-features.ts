import { applyPreparedWorkspaceEdit, prepareWorkspaceEdit } from '../file-editor.js';
import type {
  CodeActionResult,
  CompletionItemResult,
  SignatureHelpResult,
  TextDocumentEditResult,
  WorkspaceEditResult,
} from '../lsp/operations.js';
import {
  SEMANTIC_DEFAULT_LIMIT,
  SEMANTIC_MAX_LIMIT,
  boundedResultLimit,
  resolvePath,
  rethrowToolOutcome,
  spoolFullResult,
} from './helpers.js';
import {
  NAMED_QUERY_SCHEMA,
  type NamedRows,
  boundNamedRows,
  namedQueryOutcome,
  namedQueryResolutionFailed,
  normalizeNamedQuerySelector,
} from './named-query.js';
import {
  positionResolutionResult,
  resolveToolPosition,
  resolvedFromMetadata,
  resolvedFromText,
} from './position-resolver.js';
import type { ToolDefinition, ToolResult } from './registry.js';

const MAX_COMPLETION_LIMIT = 100;
const MAX_RESOLVE_LIMIT = 20;
const MAX_CODE_ACTION_LIMIT = 50;
const MAX_PREVIEW_EDITS = 5;
const MAX_PREVIEW_TEXT = 120;

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

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function completionOrder(items: CompletionItemResult[]): CompletionItemResult[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((left, right) => {
      const leftRank = left.item.sortText ?? left.item.label;
      const rightRank = right.item.sortText ?? right.item.label;
      return (
        leftRank.localeCompare(rightRank) ||
        left.item.label.localeCompare(right.item.label) ||
        left.index - right.index
      );
    })
    .map(({ item }) => item);
}

function completionOutput(item: CompletionItemResult): Record<string, unknown> {
  return {
    label: item.label,
    ...(item.kind !== undefined ? { kind: item.kind } : {}),
    ...(item.detail ? { detail: item.detail } : {}),
    ...(item.documentation ? { documentation: item.documentation } : {}),
    ...(item.insertText ? { insertText: item.insertText } : {}),
    ...(item.sortText ? { sortText: item.sortText } : {}),
  };
}

export const getCompletionsTool: ToolDefinition = {
  name: 'get_completions',
  description:
    'Get deterministic bounded completions by symbol query or position, optionally resolving details and using an in-memory synthetic dot.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      query: { type: 'string', description: 'Symbol query (alternative to line/character)' },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
      trigger_character: { type: 'string', description: 'Optional completion trigger character' },
      synthetic_trigger: {
        type: 'boolean',
        description:
          'Temporarily insert an in-memory dot and restore the exact buffer (default false)',
      },
      limit: { type: 'number', description: 'Maximum items to return (default 50, max 100)' },
      resolve_limit: {
        type: 'number',
        description:
          'Top items to resolve when supported (default min(limit, 20), max 20; 0 disables)',
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      query,
      line,
      character,
      trigger_character,
      synthetic_trigger = false,
      limit,
      resolve_limit,
    } = args as {
      file_path: string;
      query?: string;
      line?: number;
      character?: number;
      trigger_character?: string;
      synthetic_trigger?: boolean;
      limit?: number;
      resolve_limit?: number;
    };
    const absolutePath = resolvePath(file_path);
    const boundedLimit = boundedInt(limit, 50, 1, MAX_COMPLETION_LIMIT);
    const boundedResolveLimit = boundedInt(
      resolve_limit,
      Math.min(boundedLimit, MAX_RESOLVE_LIMIT),
      0,
      MAX_RESOLVE_LIMIT
    );
    try {
      const resolution = await resolveToolPosition(
        absolutePath,
        { query, line, character },
        client
      );
      if (resolution.outcome !== 'resolved') {
        return positionResolutionResult(resolution, file_path);
      }
      const result = await client.getCompletions(
        absolutePath,
        resolution.position,
        trigger_character,
        synthetic_trigger
      );
      const ordered = completionOrder(result.items);
      const selected = ordered.slice(0, boundedLimit);
      const canResolve =
        boundedResolveLimit > 0 &&
        typeof client.supportsCompletionResolve === 'function' &&
        (await client.supportsCompletionResolve(absolutePath));
      const resolveCount = canResolve ? Math.min(boundedResolveLimit, selected.length) : 0;
      const resolvedHead = await Promise.all(
        selected
          .slice(0, resolveCount)
          .map((item) => client.resolveCompletionItem(absolutePath, item, 2000))
      );
      const resolvedItems = [...resolvedHead, ...selected.slice(resolveCount)];
      const items = resolvedItems.map(completionOutput);
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      return {
        content: [
          {
            type: 'text',
            text:
              items.length === 0
                ? `${resolved ? `${resolved}\n\n` : ''}No completions found at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}`
                : `${resolved ? `${resolved}\n\n` : ''}${items.length} of ${ordered.length} completions at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}${result.syntheticTrigger ? ' (synthetic dot trigger)' : ''}:\n${JSON.stringify(items, null, 2)}`,
          },
        ],
        structuredContent: {
          outcome: items.length > 0 ? 'ok' : 'empty',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          items,
          isIncomplete: result.isIncomplete,
          truncated: ordered.length > items.length,
          resolvedCount: resolveCount,
          syntheticTrigger: result.syntheticTrigger,
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

async function signaturesForNames(
  client: Parameters<ToolDefinition['handler']>[1],
  absolutePath: string,
  filePath: string,
  queries: string[],
  triggerCharacter: string | undefined,
  maxResults: number
): Promise<ToolResult> {
  type SignatureMetadata = {
    resolution: 'resolved' | 'unavailable' | 'ambiguous' | 'not_found' | 'invalid';
    reason: string | null;
    activeSignature: number | null;
    activeParameter: number | null;
  };
  const answers: Array<NamedRows<SignatureHelpResult['signatures'][number], SignatureMetadata>> =
    [];
  for (const query of queries) {
    const resolution = await resolveToolPosition(absolutePath, { query }, client);
    if (resolution.outcome !== 'resolved') {
      const rendered = positionResolutionResult(resolution, filePath);
      answers.push({
        query,
        rows: [],
        metadata: {
          resolution: resolution.outcome,
          reason: rendered.content[0]?.text ?? 'Symbol could not be resolved',
          activeSignature: null,
          activeParameter: null,
        },
      });
      continue;
    }
    const result = await client.getSignatureHelp(
      absolutePath,
      resolution.position,
      triggerCharacter
    );
    answers.push({
      query,
      rows: result?.signatures ?? [],
      metadata: {
        resolution: 'resolved',
        reason: null,
        activeSignature: result?.activeSignature ?? null,
        activeParameter: result?.activeParameter ?? null,
      },
    });
  }
  const bounded = boundNamedRows(answers, maxResults);
  const perQuery = bounded.perQuery.map(({ rows, ...row }) => ({
    ...row,
    signatures: rows,
    // activeSignature indexes the original signature array. Once its row is
    // omitted it cannot truthfully point into the displayed subset.
    activeSignature:
      row.activeSignature !== null && row.activeSignature < row.shown ? row.activeSignature : null,
    outcome: namedQueryOutcome(row.resolution, row.total, row.shown),
  }));
  const unresolved = perQuery.some((row) => namedQueryResolutionFailed(row.resolution));
  const resultFile =
    bounded.omitted > 0
      ? spoolFullResult('get_signature_help', {
          file: absolutePath,
          queries,
          total: bounded.total,
          perQuery: answers.map((answer) => ({
            query: answer.query,
            total: answer.rows.length,
            signatures: answer.rows,
            ...answer.metadata,
          })),
        })
      : null;
  return {
    content: [
      {
        type: 'text',
        text: [
          `Signature help (${bounded.rows.length}/${bounded.total}) for ${queries.length} names:`,
          ...perQuery.flatMap((row) => [
            `  "${row.query}": ${row.total} signature(s)${row.resolution !== 'resolved' ? ` — ${row.reason}` : ''}${row.omitted > 0 ? ` — ${row.omitted} omitted, not shown here` : ''}`,
            ...(row.signatures.length > 0
              ? [
                  JSON.stringify(
                    {
                      signatures: row.signatures,
                      activeSignature: row.activeSignature,
                      activeParameter: row.activeParameter,
                    },
                    null,
                    2
                  ),
                ]
              : []),
          ]),
          ...(bounded.omitted > 0
            ? [
                `... ${bounded.omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}`,
              ]
            : []),
        ].join('\n'),
      },
    ],
    structuredContent: {
      outcome: unresolved ? 'partial' : bounded.rows.length > 0 ? 'ok' : 'empty',
      ...(unresolved ? { partial: true } : {}),
      provider: 'lsp',
      signatures: bounded.rows,
      shown: bounded.rows.length,
      total: bounded.total,
      omitted: bounded.omitted,
      queries,
      perQuery,
      recovery:
        bounded.omitted > 0
          ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the signature query.`
          : null,
      ...(resultFile ? { resultFile } : {}),
    },
    ...(unresolved ? { isError: true } : {}),
  };
}

export const getSignatureHelpTool: ToolDefinition = {
  name: 'get_signature_help',
  description:
    'Get signature and parameter help by one symbol query or an array of names (each count attributable), or by one exact 1-indexed position.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      query: {
        ...NAMED_QUERY_SCHEMA,
        description:
          'Symbol query (alternative to line/character). Pass an array to ask several names in one request.',
      },
      line: { type: 'number', description: 'The line number (1-indexed)' },
      character: { type: 'number', description: 'The character position (1-indexed)' },
      trigger_character: { type: 'string', description: 'Optional signature trigger character' },
      max_results: {
        type: 'number',
        description: `Signatures to return across every name (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, query, line, character, trigger_character, max_results } = args as {
      file_path: string;
      query?: string | string[];
      line?: number;
      character?: number;
      trigger_character?: string;
      max_results?: number;
    };
    const absolutePath = resolvePath(file_path);
    try {
      let queries: string[] | null;
      try {
        queries = normalizeNamedQuerySelector(query, line, character);
      } catch (error) {
        return positionResolutionResult(
          { outcome: 'invalid', reason: error instanceof Error ? error.message : String(error) },
          file_path
        );
      }
      if (queries && queries.length > 1) {
        return await signaturesForNames(
          client,
          absolutePath,
          file_path,
          queries,
          trigger_character,
          boundedResultLimit(max_results)
        );
      }
      const resolution = await resolveToolPosition(
        absolutePath,
        { query: queries?.[0], line, character },
        client
      );
      if (resolution.outcome !== 'resolved') {
        return positionResolutionResult(resolution, file_path);
      }
      const result = await client.getSignatureHelp(
        absolutePath,
        resolution.position,
        trigger_character
      );
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      if (!result || result.signatures.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: `${resolved ? `${resolved}\n\n` : ''}No signature help available at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}`,
            },
          ],
          structuredContent: {
            outcome: 'empty',
            provider: 'lsp',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            signatures: [],
            shown: 0,
            total: 0,
            omitted: 0,
          },
        };
      }
      const limit = boundedResultLimit(max_results);
      const signatures = result.signatures.slice(0, limit);
      const omitted = result.signatures.length - signatures.length;
      const activeSignature =
        result.activeSignature !== undefined && result.activeSignature < signatures.length
          ? result.activeSignature
          : undefined;
      const resultFile =
        omitted > 0
          ? spoolFullResult('get_signature_help', {
              file: absolutePath,
              position: resolution.position,
              ...result,
            })
          : null;
      const displayed = {
        ...result,
        signatures,
        ...(activeSignature === undefined ? { activeSignature: null } : { activeSignature }),
      };
      return {
        content: [
          {
            type: 'text',
            text: `${resolved ? `${resolved}\n\n` : ''}Signature help at ${file_path}:${resolution.position.line + 1}:${resolution.position.character + 1}:\n${JSON.stringify(displayed, null, 2)}${omitted > 0 ? `\n... ${omitted} omitted; complete result: ${resultFile ?? '(spool unavailable)'}` : ''}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          provider: 'lsp',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          ...displayed,
          shown: signatures.length,
          total: result.signatures.length,
          omitted,
          recovery:
            omitted > 0
              ? `Read the complete result at ${resultFile ?? '(spool unavailable)'} or narrow the signature query.`
              : null,
          ...(resultFile ? { resultFile } : {}),
        },
      };
    } catch (error) {
      rethrowToolOutcome(error);
      throw error;
    }
  },
};

function codeActionKindRank(kind?: string): number {
  const root = kind?.split('.')[0];
  if (root === 'quickfix') return 0;
  if (root === 'refactor') return 1;
  if (root === 'source') return 2;
  return 3;
}

function rankCodeActions(actions: CodeActionResult[]): CodeActionResult[] {
  return actions
    .map((action, index) => ({ action, index }))
    .sort(
      (left, right) =>
        Number(right.action.isPreferred === true) - Number(left.action.isPreferred === true) ||
        codeActionKindRank(left.action.kind) - codeActionKindRank(right.action.kind) ||
        left.index - right.index
    )
    .map(({ action }) => action);
}

function previewWorkspaceEdit(edit?: WorkspaceEditResult): Array<Record<string, unknown>> {
  if (!edit) return [];
  const normalized = normalizeTextWorkspaceEdit(edit);
  if (!normalized.edit?.changes) {
    return normalized.reason ? [{ unsupported: normalized.reason }] : [];
  }
  const preview: Array<Record<string, unknown>> = [];
  let total = 0;
  for (const edits of Object.values(normalized.edit.changes)) total += edits.length;
  for (const [uri, edits] of Object.entries(normalized.edit.changes)) {
    for (const textEdit of edits) {
      if (preview.length >= MAX_PREVIEW_EDITS) break;
      const text = textEdit.newText.replace(/\n/g, '\\n');
      preview.push({
        uri,
        range: textEdit.range,
        newText:
          text.length > MAX_PREVIEW_TEXT ? `${text.slice(0, MAX_PREVIEW_TEXT - 3)}...` : text,
      });
    }
    if (preview.length >= MAX_PREVIEW_EDITS) break;
  }
  if (total > preview.length) preview.push({ omittedEdits: total - preview.length });
  return preview;
}

export const getCodeActionsTool: ToolDefinition = {
  name: 'get_code_actions',
  description:
    'Rank and preview language-server code actions for a query or range; exact-title apply remains text-edit only.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: { type: 'string', description: 'The path to the file' },
      query: { type: 'string', description: 'Symbol query (alternative to start position)' },
      start_line: { type: 'number', description: 'Range start line (1-indexed)' },
      start_character: { type: 'number', description: 'Range start character (1-indexed)' },
      end_line: { type: 'number', description: 'Range end line (1-indexed)' },
      end_character: { type: 'number', description: 'Range end character (1-indexed)' },
      limit: { type: 'number', description: 'Maximum actions to list (default 20, max 50)' },
      title: { type: 'string', description: 'Exact action title to select' },
      apply: { type: 'boolean', description: 'Apply the selected WorkspaceEdit (default false)' },
      candidate_id: {
        type: 'string',
        description: 'Opaque identity from the exact-title preview; required when apply=true',
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const {
      file_path,
      query,
      start_line,
      start_character,
      end_line,
      end_character,
      limit,
      title,
      apply = false,
      candidate_id,
    } = args as {
      file_path: string;
      query?: string;
      start_line?: number;
      start_character?: number;
      end_line?: number;
      end_character?: number;
      limit?: number;
      title?: string;
      apply?: boolean;
      candidate_id?: string;
    };
    const absolutePath = resolvePath(file_path);
    try {
      const hasEndLine = end_line !== undefined;
      const hasEndCharacter = end_character !== undefined;
      if (!query && (!hasEndLine || !hasEndCharacter)) {
        return positionResolutionResult(
          {
            outcome: 'invalid',
            reason: 'coordinate calls require start_line/start_character/end_line/end_character',
          },
          file_path
        );
      }
      if (hasEndLine !== hasEndCharacter) {
        return positionResolutionResult(
          { outcome: 'invalid', reason: 'end_line and end_character must be provided together' },
          file_path
        );
      }
      if (
        hasEndLine &&
        hasEndCharacter &&
        (!Number.isInteger(end_line) ||
          !Number.isInteger(end_character) ||
          (end_line as number) < 1 ||
          (end_character as number) < 1)
      ) {
        return positionResolutionResult(
          { outcome: 'invalid', reason: 'end_line and end_character must be positive integers' },
          file_path
        );
      }
      const resolution = await resolveToolPosition(
        absolutePath,
        { query, line: start_line, character: start_character },
        client
      );
      if (resolution.outcome !== 'resolved') {
        return positionResolutionResult(resolution, file_path);
      }
      const end =
        hasEndLine && hasEndCharacter
          ? { line: (end_line as number) - 1, character: (end_character as number) - 1 }
          : resolution.position;
      const actions = rankCodeActions(
        await client.getCodeActions(absolutePath, { start: resolution.position, end })
      );
      const boundedLimit = boundedInt(limit, 20, 1, MAX_CODE_ACTION_LIMIT);
      const summaries = actions.slice(0, boundedLimit).map((action, index) => ({
        index,
        title: action.title,
        ...(action.kind ? { kind: action.kind } : {}),
        ...(action.isPreferred !== undefined ? { isPreferred: action.isPreferred } : {}),
        ...(action.disabled ? { disabled: action.disabled.reason } : {}),
        hasEdit: !!action.edit,
        commandOnly: !!action.command && !action.edit,
        preview: previewWorkspaceEdit(action.edit),
      }));
      const resolved = resolvedFromText(resolution);
      const resolvedFrom = resolvedFromMetadata(resolution);
      if (!title) {
        return {
          content: [
            {
              type: 'text',
              text:
                summaries.length === 0
                  ? `${resolved ? `${resolved}\n\n` : ''}No code actions found for ${file_path}`
                  : `${resolved ? `${resolved}\n\n` : ''}${summaries.length} of ${actions.length} code actions for ${file_path}:\n${JSON.stringify(summaries, null, 2)}`,
            },
          ],
          structuredContent: {
            outcome: summaries.length > 0 ? 'ok' : 'empty',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            actions: summaries,
            truncated: actions.length > summaries.length,
          },
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
      if (!matchedAction)
        return rejectedResult('textDocument/codeAction', 'selected action missing');
      const selected = await client.resolveCodeAction(absolutePath, matchedAction);
      if (selected.disabled)
        return rejectedResult('textDocument/codeAction', selected.disabled.reason);
      if (!selected.edit) {
        return rejectedResult(
          'textDocument/codeAction',
          selected.command
            ? 'the action requires workspace/executeCommand, which cclsp does not execute'
            : 'the action did not provide a WorkspaceEdit'
        );
      }
      const normalized = normalizeTextWorkspaceEdit(selected.edit);
      if (normalized.reason) return rejectedResult('textDocument/codeAction', normalized.reason);
      const normalizedEdit = normalized.edit;
      if (!normalizedEdit?.changes || Object.keys(normalizedEdit.changes).length === 0) {
        return rejectedResult('textDocument/codeAction', 'the action did not provide text edits');
      }
      const intent = JSON.stringify({
        operation: 'code_action',
        file: absolutePath,
        position: resolution.position,
        end,
        title,
      });
      const preparedEdit = await prepareWorkspaceEdit(normalizedEdit, intent, [absolutePath]);
      if (!apply) {
        return {
          content: [
            {
              type: 'text',
              text: `[DRY RUN] Code action "${title}" would apply:\n${JSON.stringify(normalizedEdit.changes, null, 2)}`,
            },
          ],
          structuredContent: {
            outcome: 'ok',
            ...(resolvedFrom ? { resolvedFrom } : {}),
            applied: false,
            title,
            candidateId: preparedEdit.candidateId,
            edit: normalizedEdit,
            preview: previewWorkspaceEdit(selected.edit),
          },
        };
      }
      if (!candidate_id) {
        return rejectedResult(
          'textDocument/codeAction',
          'apply requires candidate_id from an inspected exact-title preview'
        );
      }
      if (candidate_id !== preparedEdit.candidateId) {
        return rejectedResult(
          'textDocument/codeAction',
          'code action edits or source bytes changed since preview'
        );
      }
      const applied = await applyPreparedWorkspaceEdit(preparedEdit, client);
      if (!applied.success) {
        return rejectedResult('textDocument/codeAction', applied.error ?? 'failed to apply edit');
      }
      return {
        content: [
          {
            type: 'text',
            text: `Applied code action "${title}" to ${applied.filesModified.length} file(s):\n${applied.filesModified.join('\n')}`,
          },
        ],
        structuredContent: {
          outcome: 'ok',
          ...(resolvedFrom ? { resolvedFrom } : {}),
          applied: true,
          title,
          candidateId: preparedEdit.candidateId,
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
