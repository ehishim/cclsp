import { extname } from 'node:path';
import type { ServerState } from './types.js';

export type LspToolOutcomeKind = 'unsupported' | 'rejected' | 'stale' | 'too-large';

export interface LspToolOutcome {
  outcome: LspToolOutcomeKind;
  code:
    | 'LSP_METHOD_UNSUPPORTED'
    | 'LSP_RENAME_REJECTED'
    | 'LSP_ACTION_NOT_APPLICABLE'
    | 'LSP_PROJECT_NOT_READY'
    | 'LSP_RESPONSE_SPOOLED';
  method: string;
  server: string;
  reason?: string;
  /** Complete raw response when the ingress refused to materialize it in memory. */
  resultFile?: string;
  bytes?: number;
  recovery?: string;
}

export class LspToolOutcomeError extends Error {
  readonly outcome: LspToolOutcome;

  constructor(outcome: LspToolOutcome) {
    const reason = outcome.reason ? `: ${outcome.reason}` : '';
    super(`${outcome.code}: ${outcome.server} cannot complete ${outcome.method}${reason}`);
    this.name = 'LspToolOutcomeError';
    this.outcome = outcome;
  }
}

const METHOD_CAPABILITY_PATHS: Record<string, string[]> = {
  'textDocument/definition': ['definitionProvider'],
  'textDocument/typeDefinition': ['typeDefinitionProvider'],
  'textDocument/references': ['referencesProvider'],
  'textDocument/rename': ['renameProvider'],
  'textDocument/documentSymbol': ['documentSymbolProvider'],
  'textDocument/hover': ['hoverProvider'],
  'workspace/symbol': ['workspaceSymbolProvider'],
  'textDocument/implementation': ['implementationProvider'],
  'textDocument/prepareCallHierarchy': ['callHierarchyProvider'],
  'callHierarchy/incomingCalls': ['callHierarchyProvider'],
  'callHierarchy/outgoingCalls': ['callHierarchyProvider'],
  'textDocument/completion': ['completionProvider'],
  'completionItem/resolve': ['completionProvider', 'resolveProvider'],
  'textDocument/signatureHelp': ['signatureHelpProvider'],
  'textDocument/codeAction': ['codeActionProvider'],
  'codeAction/resolve': ['codeActionProvider', 'resolveProvider'],
  'textDocument/diagnostic': ['diagnosticProvider'],
  'workspace/willRenameFiles': ['workspace', 'fileOperations', 'willRename'],
  'workspace/didRenameFiles': ['workspace', 'fileOperations', 'didRename'],
};

function serverName(serverState: ServerState): string {
  return serverState.config?.command?.join(' ') ?? 'unknown language server';
}

function getPath(value: unknown, path: string[]): unknown {
  let current = value;
  for (const key of path) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isSupportedValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

export function supportsMethod(serverState: ServerState, method: string): boolean {
  const path = METHOD_CAPABILITY_PATHS[method];
  if (!path) return false;
  return isSupportedValue(getPath(serverState.serverCapabilities, path));
}

export function requireMethodSupport(serverState: ServerState, method: string): void {
  if (supportsMethod(serverState, method)) return;
  throw new LspToolOutcomeError({
    outcome: 'unsupported',
    code: 'LSP_METHOD_UNSUPPORTED',
    method,
    server: serverName(serverState),
  });
}

export function supportsPrepareRename(serverState: ServerState): boolean {
  const provider = getPath(serverState.serverCapabilities, ['renameProvider']);
  return Boolean(
    provider &&
      typeof provider === 'object' &&
      !Array.isArray(provider) &&
      (provider as Record<string, unknown>).prepareProvider === true
  );
}

export function requirePrepareRenameSupport(serverState: ServerState): void {
  if (supportsPrepareRename(serverState)) return;
  throw new LspToolOutcomeError({
    outcome: 'unsupported',
    code: 'LSP_METHOD_UNSUPPORTED',
    method: 'textDocument/prepareRename',
    server: serverName(serverState),
  });
}

interface FileOperationPattern {
  glob?: string;
  matches?: 'file' | 'folder';
}

interface FileOperationFilter {
  scheme?: string;
  pattern?: FileOperationPattern;
}

interface FileOperationRegistration {
  filters?: FileOperationFilter[];
}

function escapeRegex(value: string): string {
  return value.replace(/[|\\{}()[\]^$+?.]/g, '\\$&');
}

function globToRegExp(glob: string): RegExp {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index];
    if (char === '*') {
      if (glob[index + 1] === '*') {
        source += '.*';
        index++;
      } else {
        source += '[^/]*';
      }
    } else if (char === '?') {
      source += '[^/]';
    } else if (char === '{') {
      const close = glob.indexOf('}', index + 1);
      if (close !== -1) {
        const alternatives = glob
          .slice(index + 1, close)
          .split(',')
          .map(escapeRegex)
          .join('|');
        source += `(?:${alternatives})`;
        index = close;
      } else {
        source += '\\{';
      }
    } else {
      source += escapeRegex(char ?? '');
    }
  }
  return new RegExp(`^${source}$`);
}

function registrationMatches(value: unknown, filePath: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const filters = (value as FileOperationRegistration).filters;
  if (!Array.isArray(filters) || filters.length === 0) return false;
  const normalized = filePath.replace(/\\/g, '/');
  return filters.some((filter) => {
    if (filter.scheme && filter.scheme !== 'file') return false;
    if (filter.pattern?.matches === 'folder') return false;
    const glob = filter.pattern?.glob;
    if (!glob) return false;
    try {
      return globToRegExp(glob).test(normalized) || globToRegExp(glob).test(normalized.slice(1));
    } catch {
      return false;
    }
  });
}

export function requireFileRenameSupport(
  serverState: ServerState,
  method: 'workspace/willRenameFiles' | 'workspace/didRenameFiles',
  filePath: string
): void {
  const path = METHOD_CAPABILITY_PATHS[method];
  const registration = path ? getPath(serverState.serverCapabilities, path) : undefined;
  if (registrationMatches(registration, filePath)) return;
  throw new LspToolOutcomeError({
    outcome: 'unsupported',
    code: 'LSP_METHOD_UNSUPPORTED',
    method,
    server: serverName(serverState),
    reason: `no declared file-operation filter matches .${extname(filePath).slice(1) || 'unknown'}`,
  });
}

export function rejectRename(serverState: ServerState, reason: string): never {
  throw new LspToolOutcomeError({
    outcome: 'rejected',
    code: 'LSP_RENAME_REJECTED',
    method: 'textDocument/prepareRename',
    server: serverName(serverState),
    reason,
  });
}

export function rejectAction(serverState: ServerState, method: string, reason: string): never {
  throw new LspToolOutcomeError({
    outcome: 'rejected',
    code: 'LSP_ACTION_NOT_APPLICABLE',
    method,
    server: serverName(serverState),
    reason,
  });
}
