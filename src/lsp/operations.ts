import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { pathToUri, uriToPath } from '../utils.js';
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

/**
 * Ensure the server's view of a file matches disk before a position-based request
 * (definition, references, rename, hover, implementation, call hierarchy,
 * documentSymbol). Opens the file if needed; if it is already open but changed on
 * disk since we last synced it (mtime+size), pushes the new content and drops stale
 * diagnostics. Cheap by design: unchanged files cost only a stat — no didChange, no
 * re-analysis — so warm repeated calls stay fast while external edits are picked up.
 *
 * Returns whether the file was opened for the first time; callers may briefly wait
 * for the server to index a freshly opened file.
 */
async function ensureFreshDocument(
  serverState: ServerState,
  filePath: string
): Promise<{ justOpened: boolean }> {
  const dm = serverState.documentManager;
  const snap = readAndSign(filePath);

  if (dm.isOpen(filePath)) {
    // File gone/unreadable (snap === null): leave the server's buffer as-is rather
    // than crash — best-effort against a file deleted mid-request.
    if (snap && dm.getSyncSig(filePath) !== snap.sig) {
      logger.debug(`[DEBUG ensureFreshDocument] ${filePath} changed on disk, re-syncing\n`);
      dm.sendChange(filePath, snap.content);
      dm.setSyncSig(filePath, snap.sig);
      serverState.diagnosticsCache.delete(pathToUri(filePath));
    }
    return { justOpened: false };
  }

  const justOpened = await dm.ensureOpen(filePath);
  if (snap) dm.setSyncSig(filePath, snap.sig);
  return { justOpened };
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

  const { justOpened } = await ensureFreshDocument(serverState, filePath);
  if (justOpened) {
    logger.debug(
      '[DEBUG findDefinition] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  logger.debug('[DEBUG findDefinition] Sending textDocument/definition request\n');
  const method = 'textDocument/definition';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  logger.debug(
    `[DEBUG findDefinition] Result type: ${typeof result}, isArray: ${Array.isArray(result)}\n`
  );

  if (Array.isArray(result)) {
    logger.debug(`[DEBUG findDefinition] Array result with ${result.length} locations\n`);
    if (result.length > 0) {
      logger.debug(
        `[DEBUG findDefinition] First location: ${JSON.stringify(result[0], null, 2)}\n`
      );
    }
    return result.map((loc: LSPLocation) => ({
      uri: loc.uri,
      range: loc.range,
    }));
  }
  if (result && typeof result === 'object' && 'uri' in result) {
    logger.debug(
      `[DEBUG findDefinition] Single location result: ${JSON.stringify(result, null, 2)}\n`
    );
    const location = result as LSPLocation;
    return [{ uri: location.uri, range: location.range }];
  }

  logger.debug('[DEBUG findDefinition] No definition found or unexpected result format\n');
  return [];
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

  const { justOpened } = await ensureFreshDocument(serverState, filePath);
  if (justOpened) {
    logger.debug(
      '[DEBUG findReferences] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  const method = 'textDocument/references';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
      context: { includeDeclaration },
    },
    timeout
  );

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

export async function renameSymbol(
  serverState: ServerState,
  filePath: string,
  position: Position,
  newName: string
): Promise<{
  changes?: Record<string, Array<{ range: { start: Position; end: Position }; newText: string }>>;
}> {
  logger.debug(
    `[DEBUG renameSymbol] Requesting rename for ${filePath} at ${position.line}:${position.character} to "${newName}"\n`
  );

  await serverState.initializationPromise;

  const { justOpened } = await ensureFreshDocument(serverState, filePath);
  if (justOpened) {
    logger.debug(
      '[DEBUG renameSymbol] File was just opened, waiting for server to index project...\n'
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  logger.debug('[DEBUG renameSymbol] Sending textDocument/rename request\n');
  const method = 'textDocument/rename';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
      newName,
    },
    timeout
  );

  logger.debug(
    `[DEBUG renameSymbol] Result type: ${typeof result}, hasChanges: ${result && typeof result === 'object' && 'changes' in result}, hasDocumentChanges: ${result && typeof result === 'object' && 'documentChanges' in result}\n`
  );

  if (result && typeof result === 'object') {
    if ('changes' in result) {
      const workspaceEdit = result as {
        changes: Record<
          string,
          Array<{ range: { start: Position; end: Position }; newText: string }>
        >;
      };
      const changeCount = Object.keys(workspaceEdit.changes || {}).length;
      logger.debug(`[DEBUG renameSymbol] WorkspaceEdit has changes for ${changeCount} files\n`);
      return workspaceEdit;
    }

    if ('documentChanges' in result) {
      const workspaceEdit = result as {
        documentChanges?: Array<{
          textDocument: { uri: string; version?: number };
          edits: Array<{
            range: { start: Position; end: Position };
            newText: string;
          }>;
        }>;
      };

      logger.debug(
        `[DEBUG renameSymbol] WorkspaceEdit has documentChanges with ${workspaceEdit.documentChanges?.length || 0} entries\n`
      );

      const changes: Record<
        string,
        Array<{ range: { start: Position; end: Position }; newText: string }>
      > = {};

      if (workspaceEdit.documentChanges) {
        for (const change of workspaceEdit.documentChanges) {
          if (change.textDocument && change.edits) {
            const uri = change.textDocument.uri;
            if (!changes[uri]) {
              changes[uri] = [];
            }
            changes[uri].push(...change.edits);
            logger.debug(`[DEBUG renameSymbol] Added ${change.edits.length} edits for ${uri}\n`);
          }
        }
      }

      return { changes };
    }
  }

  logger.debug('[DEBUG renameSymbol] No rename changes available\n');
  return {};
}

export async function getDocumentSymbols(
  serverState: ServerState,
  filePath: string
): Promise<DocumentSymbol[] | SymbolInformation[]> {
  logger.debug(`[DEBUG] Requesting documentSymbol for: ${filePath}\n`);

  await serverState.initializationPromise;
  await ensureFreshDocument(serverState, filePath);

  const method = 'textDocument/documentSymbol';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;

  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
    },
    timeout
  );

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

export async function findSymbolsByName(
  serverState: ServerState,
  filePath: string,
  symbolName: string,
  symbolKind?: string
): Promise<{ matches: SymbolMatch[]; warning?: string }> {
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

  const symbols = await getDocumentSymbols(serverState, filePath);
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

// Read a file and compute a content signature (SHA-1) in one pass. Returns null if
// the file can't be read (deleted/unreadable mid-flight). We hash the actual bytes
// rather than trusting mtime/size: a stat-based signature would miss same-length
// edits made within one filesystem-timestamp tick (coarse-resolution or overlay
// filesystems), silently serving stale results. The read is cheap next to the LSP
// round-trip it lets us skip, and the content is reused for didChange when it differs.
function readAndSign(filePath: string): { content: string; sig: string } | null {
  try {
    const content = readFileSync(filePath, 'utf-8');
    return { content, sig: createHash('sha1').update(content).digest('hex') };
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
  try {
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
        // Server says nothing changed since its last report — trust the cache.
        return serverState.diagnosticsCache.get(fileUri) ?? [];
      }
    }
    // Some servers answer with a bare diagnostics array.
    if (Array.isArray(result)) {
      return result as Diagnostic[];
    }
    // Unknown/empty shape: treat as unsupported and let the caller fall back.
    return null;
  } catch (error) {
    // MethodNotFound / timeout / other: pull not usable here.
    logger.debug(
      `[DEBUG getDiagnostics] textDocument/diagnostic not supported or failed: ${error}\n`
    );
    return null;
  }
}

export async function getDiagnostics(
  serverState: ServerState,
  filePath: string
): Promise<Diagnostic[]> {
  logger.debug(`[DEBUG getDiagnostics] Requesting diagnostics for ${filePath}\n`);

  await serverState.initializationPromise;

  const fileUri = pathToUri(filePath);
  const dm = serverState.documentManager;
  const cache = serverState.diagnosticsCache;
  const snap = readAndSign(filePath);
  const method = 'textDocument/diagnostic';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;

  if (dm.isOpen(filePath)) {
    const cached = cache.get(fileUri);
    if (snap && dm.getSyncSig(filePath) === snap.sig && cached !== undefined) {
      // Fast path: file unchanged on disk since we last synced it and we already
      // have diagnostics for it. No re-sync, no round-trip.
      logger.debug(
        `[DEBUG getDiagnostics] Fast path: ${cached.length} cached diagnostics (file unchanged)\n`
      );
      return cached;
    }
    if (snap && dm.getSyncSig(filePath) !== snap.sig) {
      // File was edited externally (e.g. Claude Code's Edit tool): push the new
      // content and drop stale diagnostics.
      logger.debug('[DEBUG getDiagnostics] File changed on disk, re-syncing\n');
      dm.sendChange(filePath, snap.content);
      dm.setSyncSig(filePath, snap.sig);
      cache.delete(fileUri);
    }
  } else {
    await dm.ensureOpen(filePath);
    if (snap) dm.setSyncSig(filePath, snap.sig);
  }

  // Prefer pull diagnostics.
  const pulled = await pullDiagnostics(serverState, fileUri, timeout);
  if (pulled !== null) {
    cache.update(fileUri, pulled);
    logger.debug(`[DEBUG getDiagnostics] Pull returned ${pulled.length} diagnostics\n`);
    return pulled;
  }

  // Push-model fallback: the server doesn't support pull diagnostics.
  const cached = cache.get(fileUri);
  if (cached !== undefined) {
    logger.debug(
      `[DEBUG getDiagnostics] Returning ${cached.length} cached diagnostics from publishDiagnostics\n`
    );
    return cached;
  }

  await cache.waitForIdle(fileUri, { maxWaitTime: 8000, idleTime: 200 });
  const afterWait = cache.get(fileUri);
  if (afterWait !== undefined) {
    return afterWait;
  }

  // Last resort: nudge the server with a no-op change to trigger publishDiagnostics.
  logger.debug('[DEBUG getDiagnostics] No diagnostics yet, triggering with no-op change\n');
  try {
    const fileContent = readFileSync(filePath, 'utf-8');
    dm.sendChange(filePath, `${fileContent} `);
    dm.sendChange(filePath, fileContent);

    await cache.waitForIdle(fileUri, { maxWaitTime: 8000, idleTime: 200 });
    const afterTrigger = cache.get(fileUri);
    if (afterTrigger !== undefined) {
      return afterTrigger;
    }
  } catch (triggerError) {
    logger.debug(`[DEBUG getDiagnostics] Failed to trigger publishDiagnostics: ${triggerError}\n`);
  }

  return [];
}

export interface BatchDiagnosticResult {
  filePath: string;
  diagnostics: Diagnostic[];
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
  const cache = serverState.diagnosticsCache;
  const method = 'textDocument/diagnostic';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;

  const entries = filePaths.map((filePath) => ({ filePath, fileUri: pathToUri(filePath) }));

  // Phase 1: Open/re-sync only what changed. Files that are unchanged since the
  // last sync and already have diagnostics are reused straight from the cache.
  const toAnalyze: Array<{ filePath: string; fileUri: string }> = [];
  for (const e of entries) {
    const snap = readAndSign(e.filePath);
    if (dm.isOpen(e.filePath)) {
      if (snap && dm.getSyncSig(e.filePath) !== snap.sig) {
        dm.sendChange(e.filePath, snap.content);
        dm.setSyncSig(e.filePath, snap.sig);
        cache.delete(e.fileUri);
        toAnalyze.push(e);
      } else if (cache.get(e.fileUri) === undefined) {
        toAnalyze.push(e);
      }
      // else: unchanged and already cached -> reuse.
    } else {
      await dm.ensureOpen(e.filePath);
      if (snap) dm.setSyncSig(e.filePath, snap.sig);
      toAnalyze.push(e);
    }
  }

  // Phase 2: Get diagnostics for the files that need (re)analysis. Probe pull
  // support on the first file (serial); if it's supported, fan the rest out
  // concurrently (pull returns as soon as each file is computed). If the server
  // doesn't support pull, skip the fan-out entirely and use the push model — a
  // single batch idle wait — instead of firing N requests that would all fail.
  if (toAnalyze.length > 0) {
    const [probe, ...rest] = toAnalyze;
    const probed = probe ? await pullDiagnostics(serverState, probe.fileUri, timeout) : null;

    if (probe && probed === null) {
      logger.debug(
        '[DEBUG getDiagnosticsBatch] Pull unsupported, waiting for publishDiagnostics\n'
      );
      await cache.waitForAllIdle(
        toAnalyze.map((e) => e.fileUri),
        { maxWaitTime: 15000, idleTime: 300 }
      );
    } else {
      if (probe && probed) cache.update(probe.fileUri, probed);
      await Promise.all(
        rest.map(async (e) => {
          const pulled = await pullDiagnostics(serverState, e.fileUri, timeout);
          if (pulled !== null) cache.update(e.fileUri, pulled);
        })
      );
    }
  }

  // Phase 3: Collect results
  const results: BatchDiagnosticResult[] = entries.map((e) => ({
    filePath: e.filePath,
    diagnostics: cache.get(e.fileUri) ?? [],
  }));

  const totalDiags = results.reduce((sum, r) => sum + r.diagnostics.length, 0);
  const filesWithDiags = results.filter((r) => r.diagnostics.length > 0).length;
  logger.debug(
    `[DEBUG getDiagnosticsBatch] Found ${totalDiags} diagnostics across ${filesWithDiags}/${filePaths.length} files\n`
  );

  return results;
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
  await ensureFreshDocument(serverState, filePath);

  const method = 'textDocument/hover';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

  if (result && typeof result === 'object' && 'contents' in result) {
    return result as {
      contents: string | { kind: string; value: string };
      range?: { start: Position; end: Position };
    };
  }

  return null;
}

export async function workspaceSymbol(
  serverState: ServerState,
  query: string
): Promise<SymbolInformation[]> {
  logger.debug(`[DEBUG workspaceSymbol] Searching for "${query}"\n`);

  await serverState.initializationPromise;

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
  await ensureFreshDocument(serverState, filePath);

  const method = 'textDocument/implementation';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

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
  await ensureFreshDocument(serverState, filePath);

  const method = 'textDocument/prepareCallHierarchy';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(
    method,
    {
      textDocument: { uri: pathToUri(filePath) },
      position,
    },
    timeout
  );

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

  const method = 'callHierarchy/outgoingCalls';
  const timeout = serverState.adapter?.getTimeout?.(method) ?? 30000;
  const result = await serverState.transport.sendRequest(method, { item }, timeout);

  if (Array.isArray(result)) {
    return result as CallHierarchyOutgoingCall[];
  }

  return [];
}
