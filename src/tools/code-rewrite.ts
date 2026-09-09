import { AST_LANGUAGES, type AstRewriteOutcome } from '../ast/types.js';
import type { ToolDefinition, ToolResult } from './registry.js';

function renderRollback(
  result:
    | Extract<AstRewriteOutcome, { outcome: 'failed' }>
    | Extract<AstRewriteOutcome, { outcome: 'ok'; dryRun: false }>
): string {
  const rollback = result.rollback;
  return `rollback: attempted=${rollback.attempted} disk=${rollback.disk} providers=${rollback.providers}${rollback.failedFiles.length > 0 ? ` failed=${rollback.failedFiles.join(', ')}` : ''}`;
}

function renderText(result: AstRewriteOutcome): string {
  if (result.outcome === 'rejected') return `${result.code}: ${result.reason}`;
  if (result.outcome === 'failed') {
    return `${result.code}: ${result.reason}\n${renderRollback(result)}`;
  }
  const action = result.dryRun ? 'Structural rewrite preview' : 'Structural rewrite applied';
  const header = `${action} (${result.provider}, ${result.language}) — ${result.changesPlanned} change(s) in ${result.filesChanged} file(s) — candidate ${result.candidateId}`;
  const details = result.changes
    .map((change) => {
      const start = change.range.start;
      return `${change.file}:${start.line + 1}:${start.character + 1}\n- ${change.before}\n+ ${change.after}`;
    })
    .join('\n\n');
  const rollback = result.dryRun ? '' : `\n${renderRollback(result)}`;
  return `${header}${details ? `\n\n${details}` : ''}${rollback}`;
}

function toolResult(result: AstRewriteOutcome): ToolResult {
  return {
    content: [{ type: 'text', text: renderText(result) }],
    structuredContent: { ...result },
    ...(result.outcome === 'rejected' || result.outcome === 'failed' ? { isError: true } : {}),
  };
}

export const codeRewriteTool: ToolDefinition = {
  name: 'code_rewrite',
  description:
    'Preview or atomically apply a syntax-only Tree-sitter structural rewrite. Defaults to dry-run; applying requires the unchanged candidate_id returned by preview. Use rename_symbol_strict for semantic symbol renames.',
  inputSchema: {
    type: 'object',
    properties: {
      pattern: {
        type: 'string',
        description:
          'Structural pattern with $NAME and $$$NAME metavariables. In JS/TS, a bare key: value fragment selects an object property; use an explicit statement body for a label.',
      },
      replacement: {
        type: 'string',
        description: 'Replacement using captures from the pattern with matching arity',
      },
      language: {
        type: 'string',
        // Derived from the one language table, so an added language can never
        // ship a schema that still advertises the old set.
        description: AST_LANGUAGES.join(', '),
      },
      path: {
        type: 'string',
        description:
          'Optional root-contained safe file or directory; defaults to the registered root',
      },
      dry_run: {
        type: 'boolean',
        description: 'Preview without mutation (default true)',
        default: true,
      },
      candidate_id: {
        type: 'string',
        description: 'Opaque candidate identity from preview; required when dry_run=false',
      },
    },
    required: ['pattern', 'replacement', 'language'],
  },
  handler: async (args, client) => {
    const {
      pattern,
      replacement,
      language,
      path,
      dry_run = true,
      candidate_id,
    } = args as {
      pattern: string;
      replacement: string;
      language: string;
      path?: string;
      dry_run?: boolean;
      candidate_id?: string;
    };
    return toolResult(
      await client.codeRewrite({
        pattern,
        replacement,
        language,
        path,
        dryRun: dry_run,
        candidateId: candidate_id,
      })
    );
  },
};
