import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { pathToUri, uriToPath } from '../utils.js';
import {
  LspToolOutcomeError,
  rejectRename,
  requireFileRenameSupport,
  requireMethodSupport,
  requirePrepareRenameSupport,
  supportsMethod,
  supportsPrepareRename,
} from './capabilities.js';
import type {
  CallHierarchyIncomingCall,
  CallHierarchyItem,
  CallHierarchyOutgoingCall,
  Diagnostic,
  DocumentDiagnosticReport,
  DocumentSymbol,
  LSPLocation,
  Location,
  Position,
  ServerState,
  SymbolInformation,
  SymbolMatch,
} from './types.js';
import { SymbolKind } from './types.js';

// --- Symbol Utilities ---

export function symbolKindToString(kind: SymbolKind): string {
  const kindMap: Record<SymbolKind, string> = {
    [SymbolKind.File]: 'file',
    [SymbolKind.Module]: 'module',
    [SymbolKind.Namespace]: 'namespace',
    [SymbolKind.Package]: 'package',
    [SymbolKind.Class]: 'class',
    [SymbolKind.Method]: 'method',
    [SymbolKind.Property]: 'property',
    [SymbolKind.Field]: 'field',
    [SymbolKind.Constructor]: 'constructor',
    [SymbolKind.Enum]: 'enum',
    [SymbolKind.Interface]: 'interface',
    [SymbolKind.Function]: 'function',
    [SymbolKind.Variable]: 'variable',
    [SymbolKind.Constant]: 'constant',
    [SymbolKind.String]: 'string',
    [SymbolKind.Number]: 'number',
    [SymbolKind.Boolean]: 'boolean',
    [SymbolKind.Array]: 'array',
    [SymbolKind.Object]: 'object',
    [SymbolKind.Key]: 'key',
    [SymbolKind.Null]: 'null',
    [SymbolKind.EnumMember]: 'enum_member',
    [SymbolKind.Struct]: 'struct',
    [SymbolKind.Event]: 'event',
    [SymbolKind.Operator]: 'operator',
    [SymbolKind.TypeParameter]: 'type_parameter',
  };
  return kindMap[kind] || 'unknown';
}

export function getValidSymbolKinds(): string[] {
  return [
    'file',
    'module',
    'namespace',
    'package',
    'class',
    'method',
    'property',
    'field',
    'constructor',
    'enum',
    'interface',
    'function',
    'variable',
    'constant',
    'string',
    'number',
    'boolean',
    'array',
    'object',
    'key',
    'null',
    'enum_member',
    'struct',
    'event',
    'operator',
    'type_parameter',
  ];
}

export function stringToSymbolKind(kindStr: string): SymbolKind | null {
  const kindMap: Record<string, SymbolKind> = {
    file: SymbolKind.File,
    module: SymbolKind.Module,
    namespace: SymbolKind.Namespace,
    package: SymbolKind.Package,
    class: SymbolKind.Class,
    method: SymbolKind.Method,
    property: SymbolKind.Property,
    field: SymbolKind.Field,
    constructor: SymbolKind.Constructor,
    enum: SymbolKind.Enum,
    interface: SymbolKind.Interface,
    function: SymbolKind.Function,
    variable: SymbolKind.Variable,
    constant: SymbolKind.Constant,
    string: SymbolKind.String,
    number: SymbolKind.Number,
    boolean: SymbolKind.Boolean,
    array: SymbolKind.Array,
    object: SymbolKind.Object,
    key: SymbolKind.Key,
    null: SymbolKind.Null,
    enum_member: SymbolKind.EnumMember,
    struct: SymbolKind.Struct,
    event: SymbolKind.Event,
    operator: SymbolKind.Operator,
    type_parameter: SymbolKind.TypeParameter,
  };
  return kindMap[kindStr.toLowerCase()] || null;
}

export function flattenDocumentSymbols(symbols: DocumentSymbol[]): DocumentSymbol[] {
  const flattened: DocumentSymbol[] = [];
  for (const symbol of symbols) {
    flattened.push(symbol);
    if (symbol.children) {
      flattened.push(...flattenDocumentSymbols(symbol.children));
    }
  }
  return flattened;
}

export function isDocumentSymbolArray(
  symbols: DocumentSymbol[] | SymbolInformation[]
): symbols is DocumentSymbol[] {
  if (symbols.length === 0) return true;
  const firstSymbol = symbols[0];
  if (!firstSymbol) return true;
  return 'range' in firstSymbol && 'selectionRange' in firstSymbol;
}

export function findSymbolPositionInFile(filePath: string, symbol: SymbolInformation): Position {
  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    const lines = fileContent.split('\n');

    const range = symbol.location.range;
    const startLine = range.start.line;
    const endLine = range.end.line;

    logger.debug(
      `[DEBUG findSymbolPositionInFile] Searching for "${symbol.name}" in lines ${startLine}-${endLine}\n`
    );

    for (let lineNum = startLine; lineNum <= endLine && lineNum < lines.length; lineNum++) {
      const line = lines[lineNum];
      if (!line) continue;

      let searchStart = 0;
      if (lineNum === startLine) {
        searchStart = range.start.character;
      }

      let searchEnd = line.length;
      if (lineNum === endLine) {
        searchEnd = range.end.character;
      }

      const searchText = line.substring(searchStart, searchEnd);
      const symbolIndex = searchText.indexOf(symbol.name);

      if (symbolIndex !== -1) {
        const actualCharacter = searchStart + symbolIndex;
        logger.debug(
          `[DEBUG findSymbolPositionInFile] Found "${symbol.name}" at line ${lineNum}, character ${actualCharacter}\n`
        );
        return { line: lineNum, character: actualCharacter };
      }
    }

    logger.debug(
      `[DEBUG findSymbolPositionInFile] Symbol "${symbol.name}" not found in range, using range start\n`
    );
    return range.start;
  } catch (error) {
    logger.debug(
      `[DEBUG findSymbolPositionInFile] Error reading file: ${error}, using range start\n`
    );
    return symbol.location.range.start;
  }
}

// --- LSP Operations ---

async function ensureProjectReady(serverState: ServerState, filePath: string): Promise<void> {
  const readiness = serverState.adapter?.waitForProjectReady;
  if (!readiness) return;
  const timeout = serverState.adapter?.getTimeout?.('project/readiness') ?? 30000;
  const ready = await readiness.call(serverState.adapter, serverState, filePath, timeout);
  if (ready) return;
  throw new LspToolOutcomeError({
    outcome: 'stale',
    code: 'LSP_PROJECT_NOT_READY',
    method: 'project readiness',
    server: serverState.config.command.join(' '),
    reason: `the provider did not confirm the project graph for ${filePath} within ${timeout}ms`,
    recovery:
      'Restart the serving root, verify the language provider is healthy, then repeat the semantic request.',
  });
}

/**
 * Ensure the server's view of a file matches disk before a position-based request
 * (definition, references, rename, hover, implementation, call hierarchy,
 * documentSymbol). Opens the file if needed; if it is already open but changed on
 * disk since we last synced it (mtime+size), pushes the new content and drops stale
 * diagnostics. Cheap by design: unchanged files cost only a stat — no didChange, no
 * re-analysis — so warm repeated calls stay fast while external edits are picked up.
 *
 * Returns whether the file was opened for the first time. Provider adapters may
 * first establish project-graph readiness through their bounded native signal.
 */
async function withFreshDocument<T>(
  serverState: ServerState,
  filePath: string,
  action: (justOpened: boolean) => Promise<T>,
  exclusive = false
): Promise<T> {
  const dm = serverState.documentManager;
  const lease = await dm.acquire(filePath, exclusive);
  try {
    const snap = readAndSign(filePath);
    if (snap && dm.getSyncSig(filePath) !== snap.sig) {
      if (!lease.justOpened) {
        logger.debug(`[DEBUG withFreshDocument] ${filePath} changed on disk, re-syncing\n`);
        await dm.withWriter(async (scope) => {
          const current = readAndSign(filePath);
          if (!current) throw new Error(`LSP_FRESHNESS_UNKNOWN: cannot read ${filePath}`);
          dm.changeUnderScope(filePath, current.content, scope);
          dm.setSyncSig(filePath, current.sig);
        });
        serverState.diagnosticsCache.delete(pathToUri(filePath));
      } else {
        dm.setSyncSig(filePath, snap.sig);
      }
    }
    await ensureProjectReady(serverState, filePath);
    return await action(lease.justOpened);
  } finally {
    lease.release();
  }
}

function normalizeDefinitionLocations(result: unknown): Location[] {
  const rows = Array.isArray(result)
    ? result
    : result && typeof result === 'object'
      ? [result]
      : [];
  const locations: Location[] = [];
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    if ('uri' in row && 'range' in row) {
      const location = row as LSPLocation;
      locations.push({ uri: location.uri, range: location.range });
      continue;
    }
    if ('targetUri' in row && ('targetSelectionRange' in row || 'targetRange' in row)) {
      const link = row as {
        targetUri: string;
        targetSelectionRange?: Location['range'];
        targetRange?: Location['range'];
      };
      const range = link.targetSelectionRange ?? link.targetRange;
      if (range) locations.push({ uri: link.targetUri, range });
    }
  }
  return locations;
}

export async function findDefinition(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  logger.debug(
    `[DEBUG findDefinition] Requesting definition for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/definition');

  const result = await withFreshDocument(serverState, filePath, async () => {
    logger.debug('[DEBUG findDefinition] Sending textDocument/definition request\n');
    const method = 'textDocument/definition';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
      },
      timeout
    );
  });

  logger.debug(
    `[DEBUG findDefinition] Result type: ${typeof result}, isArray: ${Array.isArray(result)}\n`
  );

  const locations = normalizeDefinitionLocations(result);
  logger.debug(`[DEBUG findDefinition] Normalized ${locations.length} location(s)\n`);
  return locations;
}

export async function findTypeDefinition(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/typeDefinition');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/typeDefinition';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      { textDocument: { uri: pathToUri(filePath) }, position },
      timeout
    );
  });
  return normalizeDefinitionLocations(result);
}

export async function findReferences(
  serverState: ServerState,
  filePath: string,
  position: Position,
  includeDeclaration = true
): Promise<Location[]> {
  logger.debug(
    `[DEBUG] findReferences for ${filePath} at ${position.line}:${position.character}, includeDeclaration: ${includeDeclaration}\n`
  );

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/references');

  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/references';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
        context: { includeDeclaration },
      },
      timeout
    );
  });

  logger.debug(
    `[DEBUG] findReferences result type: ${typeof result}, isArray: ${Array.isArray(result)}, length: ${Array.isArray(result) ? result.length : 'N/A'}\n`
  );

  if (result && Array.isArray(result) && result.length > 0) {
    logger.debug(`[DEBUG] First reference: ${JSON.stringify(result[0], null, 2)}\n`);
  } else if (result === null || result === undefined) {
    logger.debug('[DEBUG] findReferences returned null/undefined\n');
  } else {
    logger.debug(`[DEBUG] findReferences returned unexpected result: ${JSON.stringify(result)}\n`);
  }

  if (Array.isArray(result)) {
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }

  return [];
}

export interface WorkspaceResourceRename {
  kind: 'rename';
  oldUri: string;
  newUri: string;
  options?: { overwrite?: boolean; ignoreIfExists?: boolean };
}

export type RenameOperationResult = WorkspaceEditResult & {
  prepared: boolean;
  resourceRenames: WorkspaceResourceRename[];
};

export interface RenameOperationOptions {
  allowUnpreparedPreview?: boolean;
}

function normalizeRenameWorkspaceEdit(result: unknown, prepared: boolean): RenameOperationResult {
  const changes: NonNullable<WorkspaceEditResult['changes']> = {};
  const resourceRenames: WorkspaceResourceRename[] = [];
  if (result && typeof result === 'object' && 'changes' in result) {
    const raw = (result as WorkspaceEditResult).changes;
    for (const [uri, edits] of Object.entries(raw ?? {})) {
      if (edits.length > 0) changes[uri] = [...edits];
    }
  }
  if (result && typeof result === 'object' && 'documentChanges' in result) {
    const documentChanges = (result as { documentChanges?: unknown[] }).documentChanges;
    for (const row of documentChanges ?? []) {
      if (!row || typeof row !== 'object') continue;
      if ('kind' in row) {
        const operation = row as Partial<WorkspaceResourceRename>;
        if (
          operation.kind === 'rename' &&
          typeof operation.oldUri === 'string' &&
          typeof operation.newUri === 'string'
        ) {
          resourceRenames.push({
            kind: 'rename',
            oldUri: operation.oldUri,
            newUri: operation.newUri,
            ...(operation.options ? { options: operation.options } : {}),
          });
        }
        continue;
      }
      if (!('textDocument' in row) || !('edits' in row)) continue;
      const change = row as {
        textDocument: { uri?: unknown };
        edits: Array<{ range: { start: Position; end: Position }; newText: string }>;
      };
      const uri = change.textDocument?.uri;
      if (typeof uri !== 'string' || !Array.isArray(change.edits) || change.edits.length === 0) {
        continue;
      }
      changes[uri] = [...(changes[uri] ?? []), ...change.edits];
    }
  }
  return { changes, prepared, resourceRenames };
}

export async function renameSymbol(
  serverState: ServerState,
  filePath: string,
  position: Position,
  newName: string,
  options: RenameOperationOptions = {}
): Promise<RenameOperationResult> {
  logger.debug(
    `[DEBUG renameSymbol] Requesting rename for ${filePath} at ${position.line}:${position.character} to "${newName}"\n`
  );

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/rename');
  const prepareSupported = supportsPrepareRename(serverState);
  if (!prepareSupported && options.allowUnpreparedPreview !== true) {
    requirePrepareRenameSupport(serverState);
  }

  let prepared = false;
  const result = await withFreshDocument(serverState, filePath, async () => {
    if (prepareSupported) {
      const prepareMethod = 'textDocument/prepareRename';
      const prepareTimeout = serverState.adapter?.getTimeout?.(prepareMethod) ?? 30000;
      let prepareResult: unknown;
      try {
        prepareResult = await serverState.transport.sendRequest(
          prepareMethod,
          {
            textDocument: { uri: pathToUri(filePath) },
            position,
          },
          prepareTimeout
        );
      } catch (error) {
        rejectRename(serverState, error instanceof Error ? error.message : String(error));
      }
      if (!prepareResult) {
        rejectRename(serverState, 'the language server declined this position');
      }
      prepared = true;
    }

    logger.debug('[DEBUG renameSymbol] Sending textDocument/rename request\n');
    const method = 'textDocument/rename';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
        newName,
      },
      timeout
    );
  });

  const normalized = normalizeRenameWorkspaceEdit(result, prepared);
  logger.debug(
    `[DEBUG renameSymbol] Normalized ${Object.keys(normalized.changes ?? {}).length} changed file(s), prepared=${prepared}\n`
  );
  return normalized;
}

export interface CompletionItemResult {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { kind?: string; value: string };
  insertText?: string;
  sortText?: string;
  data?: unknown;
}

export interface CompletionResult {
  items: CompletionItemResult[];
  isIncomplete: boolean;
}

export async function getCompletions(
  serverState: ServerState,
  filePath: string,
  position: Position,
  triggerCharacter?: string,
  syntheticTrigger = false
): Promise<CompletionResult & { syntheticTrigger: boolean }> {
  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/completion');
  return withFreshDocument(
    serverState,
    filePath,
    async () => {
      const method = 'textDocument/completion';
      const request = async (requestPosition: Position, synthetic: boolean) => {
        const result = await serverState.transport.sendRequest(
          method,
          {
            textDocument: { uri: pathToUri(filePath) },
            position: requestPosition,
            ...(synthetic || triggerCharacter
              ? {
                  context: {
                    triggerKind: 2,
                    triggerCharacter: synthetic ? '.' : triggerCharacter,
                  },
                }
              : { context: { triggerKind: 1 } }),
          },
          serverState.adapter?.getTimeout?.(method) ?? 30000
        );
        return normalizeCompletionResult(result, synthetic);
      };

      if (!syntheticTrigger) return request(position, false);
      const originalText = serverState.documentManager.getText(filePath);
      const insertion = originalText ? syntheticDotInsertion(originalText, position) : null;
      if (!originalText || !insertion) return request(position, false);
      const temporaryText = insertTextAt(originalText, insertion, '.');
      return serverState.documentManager.withTemporaryContent(filePath, temporaryText, () =>
        request({ line: insertion.line, character: insertion.character + 1 }, true)
      );
    },
    syntheticTrigger
  );
}

export async function resolveCompletionItem(
  serverState: ServerState,
  item: CompletionItemResult,
  timeout = 2000
): Promise<CompletionItemResult> {
  if (!supportsMethod(serverState, 'completionItem/resolve')) return item;
  const method = 'completionItem/resolve';
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const resolved = await Promise.race([
      serverState.transport.sendRequest(method, item, timeout),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('completion item resolve timeout')), timeout);
      }),
    ]);
    return resolved && typeof resolved === 'object'
      ? { ...item, ...(resolved as CompletionItemResult) }
      : item;
  } catch {
    return item;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeCompletionResult(
  result: unknown,
  syntheticTrigger: boolean
): CompletionResult & { syntheticTrigger: boolean } {
  if (Array.isArray(result)) {
    return { items: result as CompletionItemResult[], isIncomplete: false, syntheticTrigger };
  }
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as { items?: unknown }).items)
  ) {
    const list = result as { items: CompletionItemResult[]; isIncomplete?: boolean };
    return {
      items: list.items,
      isIncomplete: list.isIncomplete === true,
      syntheticTrigger,
    };
  }
  return { items: [], isIncomplete: false, syntheticTrigger };
}

function syntheticDotInsertion(content: string, position: Position): Position | null {
  const lines = content.split('\n');
  const line = lines[position.line];
  if (line === undefined || position.character < 0 || position.character > line.length) return null;
  let character = position.character;
  if (character < line.length && /[\w$]/.test(line[character] ?? '')) {
    while (character < line.length && /[\w$]/.test(line[character] ?? '')) character++;
  }
  if (line[character] === '.') return null;
  const previous = character > 0 ? line[character - 1] : '';
  return /[\w$)\]]/.test(previous ?? '') ? { line: position.line, character } : null;
}

function insertTextAt(content: string, position: Position, inserted: string): string {
  const lines = content.split('\n');
  const line = lines[position.line] ?? '';
  lines[position.line] =
    `${line.slice(0, position.character)}${inserted}${line.slice(position.character)}`;
  return lines.join('\n');
}

export interface SignatureHelpResult {
  signatures: Array<{
    label: string;
    documentation?: string | { kind?: string; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { value: string };
    }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

export async function getSignatureHelp(
  serverState: ServerState,
  filePath: string,
  position: Position,
  triggerCharacter?: string
): Promise<SignatureHelpResult | null> {
  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/signatureHelp');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/signatureHelp';
    return serverState.transport.sendRequest(
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        position,
        ...(triggerCharacter
          ? { context: { triggerKind: 2, triggerCharacter, isRetrigger: false } }
          : {}),
      },
      serverState.adapter?.getTimeout?.(method) ?? 30000
    );
  });
  if (
    result &&
    typeof result === 'object' &&
    Array.isArray((result as SignatureHelpResult).signatures)
  ) {
    return result as SignatureHelpResult;
  }
  return null;
}

export interface TextDocumentEditResult {
  textDocument: { uri: string; version?: number | null };
  edits: Array<{ range: { start: Position; end: Position }; newText: string }>;
}

export interface WorkspaceEditResult {
  changes?: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
  documentChanges?: unknown[];
}

export interface CodeActionResult {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: WorkspaceEditResult;
  command?: { title: string; command: string; arguments?: unknown[] };
  data?: unknown;
}

export async function getCodeActions(
  serverState: ServerState,
  filePath: string,
  range: { start: Position; end: Position }
): Promise<CodeActionResult[]> {
  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/codeAction');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/codeAction';
    return serverState.transport.sendRequest(
      method,
      {
        textDocument: { uri: pathToUri(filePath) },
        range,
        context: { diagnostics: [] },
      },
      serverState.adapter?.getTimeout?.(method) ?? 30000
    );
  });
  return Array.isArray(result) ? (result as CodeActionResult[]) : [];
}

export async function resolveCodeAction(
  serverState: ServerState,
  action: CodeActionResult
): Promise<CodeActionResult> {
  if (action.edit || action.disabled) return action;
  if (!supportsMethod(serverState, 'codeAction/resolve')) return action;
  const method = 'codeAction/resolve';
  const result = await serverState.transport.sendRequest(
    method,
    action,
    serverState.adapter?.getTimeout?.(method) ?? 30000
  );
  return result && typeof result === 'object' ? (result as CodeActionResult) : action;
}

export interface FileRenamePair {
  oldPath: string;
  newPath: string;
}

export async function willRenameFilesBatch(
  serverState: ServerState,
  moves: FileRenamePair[]
): Promise<WorkspaceEditResult> {
  await serverState.initializationPromise;
  const leases = [];
  try {
    for (const move of moves) {
      requireFileRenameSupport(serverState, 'workspace/willRenameFiles', move.oldPath);
      leases.push(await serverState.documentManager.acquire(move.oldPath));
    }
    for (const move of moves) await ensureProjectReady(serverState, move.oldPath);
    const method = 'workspace/willRenameFiles';
    const result = await serverState.transport.sendRequest(
      method,
      {
        files: moves.map((move) => ({
          oldUri: pathToUri(move.oldPath),
          newUri: pathToUri(move.newPath),
        })),
      },
      serverState.adapter?.getTimeout?.(method) ?? 30000
    );
    if (!result || typeof result !== 'object') return {};
    if ('changes' in result) {
      const changes = (result as WorkspaceEditResult).changes ?? {};
      return {
        changes: serverState.adapter?.reconcileFileRenameEdits?.(changes, moves) ?? changes,
      };
    }
    if ('documentChanges' in result) {
      const changes: NonNullable<WorkspaceEditResult['changes']> = {};
      const documentChanges = (result as { documentChanges?: unknown[] }).documentChanges;
      for (const change of documentChanges ?? []) {
        if (
          !change ||
          typeof change !== 'object' ||
          !('textDocument' in change) ||
          !('edits' in change)
        ) {
          continue;
        }
        const textChange = change as {
          textDocument: { uri: string };
          edits: Array<{ range: { start: Position; end: Position }; newText: string }>;
        };
        changes[textChange.textDocument.uri] = [
          ...(changes[textChange.textDocument.uri] ?? []),
          ...textChange.edits,
        ];
      }
      return {
        changes: serverState.adapter?.reconcileFileRenameEdits?.(changes, moves) ?? changes,
      };
    }
    return {};
  } finally {
    for (const lease of leases) lease.release();
  }
}

export async function willRenameFiles(
  serverState: ServerState,
  oldPath: string,
  newPath: string
): Promise<WorkspaceEditResult> {
  return willRenameFilesBatch(serverState, [{ oldPath, newPath }]);
}

export async function didRenameFilesBatch(
  serverState: ServerState,
  moves: FileRenamePair[]
): Promise<void> {
  if (!supportsMethod(serverState, 'workspace/didRenameFiles')) return;
  for (const move of moves) {
    requireFileRenameSupport(serverState, 'workspace/didRenameFiles', move.newPath);
  }
  serverState.transport.sendNotification('workspace/didRenameFiles', {
    files: moves.map((move) => ({
      oldUri: pathToUri(move.oldPath),
      newUri: pathToUri(move.newPath),
    })),
  });
}

export async function didRenameFiles(
  serverState: ServerState,
  oldPath: string,
  newPath: string
): Promise<void> {
  return didRenameFilesBatch(serverState, [{ oldPath, newPath }]);
}

export async function getDocumentSymbols(
  serverState: ServerState,
  filePath: string
): Promise<DocumentSymbol[] | SymbolInformation[]> {
  logger.debug(`[DEBUG] Requesting documentSymbol for: ${filePath}\n`);

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/documentSymbol');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/documentSymbol';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      { textDocument: { uri: pathToUri(filePath) } },
      timeout
    );
  });

  logger.debug(
    `[DEBUG] documentSymbol result type: ${typeof result}, isArray: ${Array.isArray(result)}, length: ${Array.isArray(result) ? result.length : 'N/A'}\n`
  );

  if (result && Array.isArray(result) && result.length > 0) {
    logger.debug(`[DEBUG] First symbol: ${JSON.stringify(result[0], null, 2)}\n`);
  } else if (result === null || result === undefined) {
    logger.debug('[DEBUG] documentSymbol returned null/undefined\n');
  } else {
    logger.debug(`[DEBUG] documentSymbol returned unexpected result: ${JSON.stringify(result)}\n`);
  }

  if (Array.isArray(result)) {
    return result as DocumentSymbol[] | SymbolInformation[];
  }

  return [];
}

/**
 * Matches already-resolved symbols by name and kind. It takes the symbols rather than a
 * server because the tier that produced them is not its concern: a tree-sitter parse of one
 * file needs no language server, and the kind fallback and position rules below must be the
 * same either way.
 */
export async function matchSymbolsByName(
  filePath: string,
  inputSymbols: Array<DocumentSymbol | SymbolInformation>,
  symbolName: string,
  symbolKind?: string
): Promise<{ matches: SymbolMatch[]; warning?: string }> {
  // isDocumentSymbolArray narrows at runtime; this only reconciles a mixed-element array with
  // the union-of-arrays spelling the branches below are written against.
  const symbols = inputSymbols as DocumentSymbol[] | SymbolInformation[];
  logger.debug(
    `[DEBUG findSymbolsByName] Searching for symbol "${symbolName}" with kind "${symbolKind || 'any'}" in ${filePath}\n`
  );

  let validationWarning: string | undefined;
  let effectiveSymbolKind = symbolKind;
  if (symbolKind && stringToSymbolKind(symbolKind) === null) {
    const validKinds = getValidSymbolKinds();
    validationWarning = `⚠️ Invalid symbol kind "${symbolKind}". Valid kinds are: ${validKinds.join(', ')}. Searching all symbol types instead.`;
    effectiveSymbolKind = undefined;
  }

  const matches: SymbolMatch[] = [];

  logger.debug(`[DEBUG findSymbolsByName] Got ${symbols.length} symbols from documentSymbols\n`);

  if (isDocumentSymbolArray(symbols)) {
    logger.debug('[DEBUG findSymbolsByName] Processing DocumentSymbol[] (hierarchical format)\n');
    const flatSymbols = flattenDocumentSymbols(symbols);
    logger.debug(`[DEBUG findSymbolsByName] Flattened to ${flatSymbols.length} symbols\n`);

    for (const symbol of flatSymbols) {
      const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
      const kindMatches =
        !effectiveSymbolKind ||
        symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

      logger.debug(
        `[DEBUG findSymbolsByName] Checking DocumentSymbol: ${symbol.name} (${symbolKindToString(symbol.kind)}) - nameMatch: ${nameMatches}, kindMatch: ${kindMatches}\n`
      );

      if (nameMatches && kindMatches) {
        logger.debug(
          `[DEBUG findSymbolsByName] DocumentSymbol match: ${symbol.name} (kind=${symbol.kind}) using selectionRange ${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}\n`
        );
        matches.push({
          name: symbol.name,
          kind: symbol.kind,
          position: symbol.selectionRange.start,
          range: symbol.range,
          detail: symbol.detail,
        });
      }
    }
  } else {
    logger.debug('[DEBUG findSymbolsByName] Processing SymbolInformation[] (flat format)\n');
    for (const symbol of symbols) {
      const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
      const kindMatches =
        !effectiveSymbolKind ||
        symbolKindToString(symbol.kind) === effectiveSymbolKind.toLowerCase();

      logger.debug(
        `[DEBUG findSymbolsByName] Checking SymbolInformation: ${symbol.name} (${symbolKindToString(symbol.kind)}) - nameMatch: ${nameMatches}, kindMatch: ${kindMatches}\n`
      );

      if (nameMatches && kindMatches) {
        logger.debug(
          `[DEBUG findSymbolsByName] SymbolInformation match: ${symbol.name} (kind=${symbol.kind}) at ${symbol.location.range.start.line}:${symbol.location.range.start.character} to ${symbol.location.range.end.line}:${symbol.location.range.end.character}\n`
        );
        const position = findSymbolPositionInFile(filePath, symbol);
        logger.debug(
          `[DEBUG findSymbolsByName] Found symbol position in file: ${position.line}:${position.character}\n`
        );
        matches.push({
          name: symbol.name,
          kind: symbol.kind,
          position: position,
          range: symbol.location.range,
          detail: undefined,
        });
      }
    }
  }

  logger.debug(`[DEBUG findSymbolsByName] Found ${matches.length} matching symbols\n`);

  let fallbackWarning: string | undefined;
  if (effectiveSymbolKind && matches.length === 0) {
    logger.debug(
      `[DEBUG findSymbolsByName] No matches found for kind "${effectiveSymbolKind}", trying fallback search for all kinds\n`
    );

    const fallbackMatches: SymbolMatch[] = [];

    if (isDocumentSymbolArray(symbols)) {
      const flatSymbols = flattenDocumentSymbols(symbols);
      for (const symbol of flatSymbols) {
        const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
        if (nameMatches) {
          fallbackMatches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: symbol.selectionRange.start,
            range: symbol.range,
            detail: symbol.detail,
          });
        }
      }
    } else {
      for (const symbol of symbols) {
        const nameMatches = symbol.name === symbolName || symbol.name.includes(symbolName);
        if (nameMatches) {
          const position = findSymbolPositionInFile(filePath, symbol);
          fallbackMatches.push({
            name: symbol.name,
            kind: symbol.kind,
            position: position,
            range: symbol.location.range,
            detail: undefined,
          });
        }
      }
    }

    if (fallbackMatches.length > 0) {
      const foundKinds = [...new Set(fallbackMatches.map((m) => symbolKindToString(m.kind)))];
      fallbackWarning = `⚠️ No symbols found with kind "${effectiveSymbolKind}". Found ${fallbackMatches.length} symbol(s) with name "${symbolName}" of other kinds: ${foundKinds.join(', ')}.`;
      matches.push(...fallbackMatches);
      logger.debug(
        `[DEBUG findSymbolsByName] Fallback search found ${fallbackMatches.length} additional matches\n`
      );
    }
  }

  const combinedWarning = [validationWarning, fallbackWarning].filter(Boolean).join(' ');
  return { matches, warning: combinedWarning || undefined };
}

export async function findSymbolsByName(
  serverState: ServerState,
  filePath: string,
  symbolName: string,
  symbolKind?: string
): Promise<{ matches: SymbolMatch[]; warning?: string }> {
  const symbols = await getDocumentSymbols(serverState, filePath);
  return matchSymbolsByName(filePath, symbols, symbolName, symbolKind);
}

// Read a file and compute a content signature (SHA-1) in one pass. Returns null if
// the file can't be read (deleted/unreadable mid-flight). We hash the actual bytes
// rather than trusting mtime/size: a stat-based signature would miss same-length
// edits made within one filesystem-timestamp tick (coarse-resolution or overlay
// filesystems), silently serving stale results. The read is cheap next to the LSP
// round-trip it lets us skip, and the content is reused for didChange when it differs.
export function contentSignature(content: string): string {
  return createHash('sha1').update(content).digest('hex');
}

function readAndSign(filePath: string): { content: string; sig: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return { content, sig: contentSignature(content) };
  } catch {
    return null;
  }
}

/**
 * Pull current diagnostics via textDocument/diagnostic (LSP pull model).
 * Returns the diagnostics on success, or null if the server does not support
 * pull diagnostics (the caller should then fall back to the push model).
 *
 * Pull is preferred because it is authoritative and returns as soon as the
 * server has computed diagnostics — no idle-time guessing.
 */
async function pullDiagnostics(
  serverState: ServerState,
  fileUri: string,
  timeout: number
): Promise<Diagnostic[] | null> {
  if (!supportsMethod(serverState, 'textDocument/diagnostic')) {
    return serverState.adapter?.pullDiagnostics?.(serverState, uriToPath(fileUri), timeout) ?? null;
  }
  {
    const result = await serverState.transport.sendRequest(
      'textDocument/diagnostic',
      { textDocument: { uri: fileUri } },
      timeout
    );

    if (result && typeof result === 'object' && 'kind' in result) {
      const report = result as DocumentDiagnosticReport;
      if (report.kind === 'full' && report.items) {
        return report.items;
      }
      if (report.kind === 'unchanged') {
        throw new Error(
          'LSP_REQUEST_INVALID_RESPONSE: unchanged report without a previous result id'
        );
      }
    }
    // Some servers answer with a bare diagnostics array.
    if (Array.isArray(result)) {
      return result as Diagnostic[];
    }
    throw new Error('LSP_REQUEST_INVALID_RESPONSE: diagnostic response has no supported report');
  }
}

export interface DiagnosticFreshness {
  epoch: number;
  resynced: string[];
  bytesCompared: number;
  status: 'current' | 'unverified' | 'unknown';
  causality: 'pull' | 'request' | 'push';
  waitedFor: string[];
  changedDuringRequest: string[];
}

export async function getDiagnostics(
  serverState: ServerState,
  filePath: string
): Promise<Diagnostic[]> {
  const report = await getDiagnosticsReport(serverState, filePath);
  if (report.freshness.status !== 'current') {
    const error = new Error(
      report.reason ?? 'LSP_DIAGNOSTICS_UNKNOWN: diagnostics are not current'
    );
    Object.assign(error, report, { status: report.freshness.status });
    throw error;
  }
  return report.diagnostics;
}

export async function getDiagnosticsReport(
  serverState: ServerState,
  filePath: string
): Promise<{ diagnostics: Diagnostic[]; freshness: DiagnosticFreshness; reason?: string }> {
  const [result] = await getDiagnosticsBatch(serverState, [filePath]);
  if (!result?.freshness) throw new Error('LSP_DIAGNOSTICS_UNKNOWN: missing file result');
  return { diagnostics: result.diagnostics, freshness: result.freshness, reason: result.reason };
}

export interface BatchDiagnosticResult {
  filePath: string;
  diagnostics: Diagnostic[];
  status?: 'current' | 'unverified' | 'unknown';
  reason?: string;
  freshness?: DiagnosticFreshness;
}

export async function getDiagnosticsBatch(
  serverState: ServerState,
  filePaths: string[]
): Promise<BatchDiagnosticResult[]> {
  logger.debug(
    `[DEBUG getDiagnosticsBatch] Requesting diagnostics for ${filePaths.length} files\n`
  );

  await serverState.initializationPromise;

  const dm = serverState.documentManager;
  if (filePaths.length > dm.capacity) {
    const results: BatchDiagnosticResult[] = [];
    for (let offset = 0; offset < filePaths.length; offset += dm.capacity) {
      results.push(
        ...(await getDiagnosticsBatch(serverState, filePaths.slice(offset, offset + dm.capacity)))
      );
    }
    return results;
  }
  const leases = await dm.acquireChunk(filePaths);
  try {
    const method = 'textDocument/diagnostic';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;

    const entries = filePaths.map((filePath) => ({ filePath, fileUri: pathToUri(filePath) }));

    const snapshot = await dm.reconcile();
    const results: BatchDiagnosticResult[] = new Array(entries.length);
    let next = 0;
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(4, entries.length) }, async () => {
        while (next < entries.length) {
          const index = next++;
          const entry = entries[index];
          if (!entry) continue;
          try {
            const pulled = await pullDiagnostics(serverState, entry.fileUri, timeout);
            const cached = serverState.diagnosticsCache.get(entry.fileUri);
            results[index] =
              pulled === null
                ? {
                    filePath: entry.filePath,
                    diagnostics: cached ?? [],
                    status: cached === undefined ? 'unknown' : 'unverified',
                    reason:
                      'LSP_DIAGNOSTICS_UNKNOWN: provider has no request-based diagnostics; use a pull-capable provider or typescript-language-server >=5.3',
                  }
                : { filePath: entry.filePath, diagnostics: pulled, status: 'current' };
          } catch (error) {
            results[index] = {
              filePath: entry.filePath,
              diagnostics: [],
              status: 'unknown',
              reason: String(error),
            };
          }
        }
      })
    );
    const failed = workers.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
    const changed = await dm.changedSince(snapshot);
    if (changed.length > 0) {
      for (const result of results) {
        if (result.status === 'current') result.status = 'unverified';
        result.reason = `LSP_FRESHNESS_UNKNOWN: files changed during diagnostics: ${changed.join(', ')}`;
      }
    }

    for (const result of results) {
      result.freshness = {
        epoch: snapshot.epoch,
        resynced: snapshot.resynced,
        bytesCompared: snapshot.bytesCompared,
        status: result.status ?? 'unknown',
        causality: supportsMethod(serverState, method)
          ? 'pull'
          : serverState.adapter?.pullDiagnostics
            ? 'request'
            : 'push',
        waitedFor: snapshot.waitedFor ?? [],
        changedDuringRequest: changed,
      };
    }
    const totalDiags = results.reduce((sum, r) => sum + r.diagnostics.length, 0);
    const filesWithDiags = results.filter((r) => r.diagnostics.length > 0).length;
    logger.debug(
      `[DEBUG getDiagnosticsBatch] Found ${totalDiags} diagnostics across ${filesWithDiags}/${filePaths.length} files\n`
    );

    return results;
  } finally {
    for (const lease of leases) lease.release();
  }
}

export async function hover(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<{
  contents: string | { kind: string; value: string };
  range?: { start: Position; end: Position };
} | null> {
  logger.debug(
    `[DEBUG hover] Requesting hover for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/hover');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/hover';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      { textDocument: { uri: pathToUri(filePath) }, position },
      timeout
    );
  });

  if (result && typeof result === 'object' && 'contents' in result) {
    return result as {
      contents: string | { kind: string; value: string };
      range?: { start: Position; end: Position };
    };
  }

  return null;
}

/** Resolve a file's hover positions under one freshness lease, preserving input order. */
export async function hoverBatch(
  serverState: ServerState,
  filePath: string,
  positions: Position[]
): Promise<Array<Awaited<ReturnType<typeof hover>>>> {
  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/hover');
  return withFreshDocument(serverState, filePath, async () => {
    const before = readAndSign(filePath);
    if (!before) throw new Error(`LSP_FRESHNESS_UNKNOWN: cannot read ${filePath}`);
    const results: Array<Awaited<ReturnType<typeof hover>>> = new Array(positions.length);
    let next = 0;
    let failed = false;
    let failure: unknown;
    await Promise.all(
      Array.from({ length: Math.min(8, positions.length) }, async () => {
        for (;;) {
          const index = next++;
          const position = positions[index];
          if (!position || failed) return;
          try {
            const result = await serverState.transport.sendRequest(
              'textDocument/hover',
              { textDocument: { uri: pathToUri(filePath) }, position },
              serverState.adapter?.getTimeout?.('textDocument/hover') ?? 30000
            );
            results[index] =
              result && typeof result === 'object' && 'contents' in result
                ? (result as NonNullable<Awaited<ReturnType<typeof hover>>>)
                : null;
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
      })
    );
    if (failed) throw failure;
    const after = readAndSign(filePath);
    if (!after || after.sig !== before.sig) {
      throw new LspToolOutcomeError({
        outcome: 'stale',
        code: 'LSP_PROJECT_NOT_READY',
        method: 'textDocument/hover',
        server: serverState.config.command.join(' '),
        reason: 'source changed during the hover batch; no mixed-version result is returned',
        recovery: 'Repeat the batch against the current source.',
      });
    }
    return results;
  });
}

export async function workspaceSymbol(
  serverState: ServerState,
  query: string
): Promise<SymbolInformation[]> {
  logger.debug(`[DEBUG workspaceSymbol] Searching for "${query}"\n`);

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'workspace/symbol');

  const method = 'workspace/symbol';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { query }, timeout);

  if (Array.isArray(result)) {
    return result as SymbolInformation[];
  }

  return [];
}

export async function findImplementation(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<Location[]> {
  logger.debug(
    `[DEBUG findImplementation] Requesting implementation for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/implementation');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/implementation';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      { textDocument: { uri: pathToUri(filePath) }, position },
      timeout
    );
  });

  if (Array.isArray(result)) {
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }
  if (result && typeof result === 'object' && 'uri' in result) {
    const location = result as LSPLocation;
    return [{ uri: location.uri, range: location.range }];
  }

  return [];
}

export async function prepareCallHierarchy(
  serverState: ServerState,
  filePath: string,
  position: Position
): Promise<CallHierarchyItem[]> {
  logger.debug(
    `[DEBUG prepareCallHierarchy] Requesting call hierarchy for ${filePath} at ${position.line}:${position.character}\n`
  );

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'textDocument/prepareCallHierarchy');
  const result = await withFreshDocument(serverState, filePath, async () => {
    const method = 'textDocument/prepareCallHierarchy';
    const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
    return serverState.transport.sendRequest(
      method,
      { textDocument: { uri: pathToUri(filePath) }, position },
      timeout
    );
  });

  if (Array.isArray(result)) {
    return result as CallHierarchyItem[];
  }

  return [];
}

export async function incomingCalls(
  serverState: ServerState,
  item: CallHierarchyItem
): Promise<CallHierarchyIncomingCall[]> {
  logger.debug(`[DEBUG incomingCalls] Requesting incoming calls for ${item.name}\n`);

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'callHierarchy/incomingCalls');

  const method = 'callHierarchy/incomingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyIncomingCall[];
  }

  return [];
}

export async function outgoingCalls(
  serverState: ServerState,
  item: CallHierarchyItem
): Promise<CallHierarchyOutgoingCall[]> {
  logger.debug(`[DEBUG outgoingCalls] Requesting outgoing calls for ${item.name}\n`);

  await serverState.initializationPromise;
  requireMethodSupport(serverState, 'callHierarchy/outgoingCalls');

  const method = 'callHierarchy/outgoingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyOutgoingCall[];
  }

  return [];
}
