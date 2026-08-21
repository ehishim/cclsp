import { readFileSync } from 'node:fs';
import { logger } from '../logger.js';
import { DEFAULT_MAX_OPEN_DOCUMENTS } from '../types.js';
import { pathToUri } from '../utils.js';
import type { JsonRpcTransport } from './json-rpc.js';

interface DocumentState {
  version: number;
  text: string;
  syncSignature?: string;
  activeUses: number;
  exclusiveUse: boolean;
}

export interface DocumentLease {
  justOpened: boolean;
  release(): void;
}

export class DocumentManager {
  private readonly documents = new Map<string, DocumentState>();
  private readonly temporaryDocuments = new Set<string>();
  private readonly leaseWaiters = new Map<string, Array<() => void>>();
  private readonly pendingExclusiveUses = new Map<string, number>();
  private readonly maxOpenDocuments: number;

  constructor(
    private readonly transport: JsonRpcTransport,
    maxOpenDocuments = DEFAULT_MAX_OPEN_DOCUMENTS,
    private readonly onClose?: (filePath: string) => void
  ) {
    if (!Number.isInteger(maxOpenDocuments) || maxOpenDocuments < 1) {
      throw new Error('maxOpenDocuments must be an integer greater than or equal to 1');
    }
    this.maxOpenDocuments = maxOpenDocuments;
  }

  async ensureOpen(filePath: string): Promise<boolean> {
    const existing = this.documents.get(filePath);
    if (existing) {
      this.touch(filePath, existing);
      return false;
    }

    this.open(filePath, 0);
    this.evictInactiveDocuments();
    return true;
  }

  async acquire(filePath: string, exclusive = false): Promise<DocumentLease> {
    if (exclusive) {
      this.pendingExclusiveUses.set(filePath, (this.pendingExclusiveUses.get(filePath) ?? 0) + 1);
    }
    try {
      await this.waitForLease(filePath, exclusive);
    } finally {
      if (exclusive) {
        const remaining = (this.pendingExclusiveUses.get(filePath) ?? 1) - 1;
        if (remaining > 0) this.pendingExclusiveUses.set(filePath, remaining);
        else this.pendingExclusiveUses.delete(filePath);
      }
    }
    let state = this.documents.get(filePath);
    const justOpened = !state;
    if (!state) {
      state = this.open(filePath, 1, exclusive);
    } else {
      state.activeUses++;
      state.exclusiveUse = exclusive;
      this.touch(filePath, state);
    }
    this.evictInactiveDocuments();

    let released = false;
    return {
      justOpened,
      release: () => {
        if (released) return;
        released = true;
        const current = this.documents.get(filePath);
        if (current) {
          current.activeUses = Math.max(0, current.activeUses - 1);
          if (exclusive) current.exclusiveUse = false;
          this.touch(filePath, current);
        }
        for (const resolve of this.leaseWaiters.get(filePath) ?? []) resolve();
        this.leaseWaiters.delete(filePath);
        this.evictInactiveDocuments();
      },
    };
  }

  sendChange(filePath: string, text: string): void {
    if (this.temporaryDocuments.has(filePath)) {
      throw new Error(`Cannot change a document while temporary content is active: ${filePath}`);
    }
    this.sendChangeInternal(filePath, text);
  }

  async withTemporaryContent<T>(
    filePath: string,
    temporaryText: string,
    action: () => Promise<T>
  ): Promise<T> {
    const state = this.documents.get(filePath);
    if (!state) {
      throw new Error(`Cannot temporarily change unopened document: ${filePath}`);
    }
    if (this.temporaryDocuments.has(filePath)) {
      throw new Error(`A temporary document change is already active: ${filePath}`);
    }

    const originalText = state.text;
    this.temporaryDocuments.add(filePath);
    try {
      this.sendChangeInternal(filePath, temporaryText);
      return await action();
    } finally {
      try {
        this.sendChangeInternal(filePath, originalText);
      } finally {
        this.temporaryDocuments.delete(filePath);
        for (const resolve of this.leaseWaiters.get(filePath) ?? []) resolve();
        this.leaseWaiters.delete(filePath);
      }
    }
  }

  isOpen(filePath: string): boolean {
    return this.documents.has(filePath);
  }

  getText(filePath: string): string | undefined {
    return this.documents.get(filePath)?.text;
  }

  getSyncSig(filePath: string): string | undefined {
    return this.documents.get(filePath)?.syncSignature;
  }

  setSyncSig(filePath: string, signature: string): void {
    const state = this.documents.get(filePath);
    if (state) state.syncSignature = signature;
  }

  getVersion(filePath: string): number {
    return this.documents.get(filePath)?.version ?? 0;
  }

  getOpenCount(): number {
    return this.documents.size;
  }

  private sendChangeInternal(filePath: string, text: string): void {
    const state = this.documents.get(filePath);
    if (!state) {
      throw new Error(`Cannot change unopened document: ${filePath}`);
    }
    state.version++;
    state.text = text;
    this.touch(filePath, state);
    this.transport.sendNotification('textDocument/didChange', {
      textDocument: { uri: pathToUri(filePath), version: state.version },
      contentChanges: [{ text }],
    });
  }

  private async waitForLease(filePath: string, exclusive: boolean): Promise<void> {
    while (true) {
      const state = this.documents.get(filePath);
      if (
        !this.temporaryDocuments.has(filePath) &&
        (!state ||
          (!state.exclusiveUse &&
            (exclusive
              ? state.activeUses === 0
              : (this.pendingExclusiveUses.get(filePath) ?? 0) === 0)))
      ) {
        return;
      }
      await new Promise<void>((resolve) => {
        const waiters = this.leaseWaiters.get(filePath) ?? [];
        waiters.push(resolve);
        this.leaseWaiters.set(filePath, waiters);
      });
    }
  }

  private open(filePath: string, activeUses: number, exclusiveUse = false): DocumentState {
    logger.debug(`[DEBUG ensureOpen] Opening file: ${filePath}\n`);
    const text = readFileSync(filePath, 'utf-8');
    const state: DocumentState = { version: 1, text, activeUses, exclusiveUse };
    this.documents.set(filePath, state);
    this.transport.sendNotification('textDocument/didOpen', {
      textDocument: {
        uri: pathToUri(filePath),
        languageId: getLanguageId(filePath),
        version: state.version,
        text,
      },
    });
    return state;
  }

  private touch(filePath: string, state: DocumentState): void {
    this.documents.delete(filePath);
    this.documents.set(filePath, state);
  }

  private evictInactiveDocuments(): void {
    while (this.documents.size > this.maxOpenDocuments) {
      let candidate: [string, DocumentState] | undefined;
      for (const entry of this.documents) {
        if (entry[1].activeUses === 0) {
          candidate = entry;
          break;
        }
      }
      if (!candidate) return;
      const [filePath] = candidate;
      this.documents.delete(filePath);
      this.transport.sendNotification('textDocument/didClose', {
        textDocument: { uri: pathToUri(filePath) },
      });
      this.onClose?.(filePath);
    }
  }
}

export function getLanguageId(filePath: string): string {
  const extension = filePath.split('.').pop()?.toLowerCase();
  const languageMap: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescriptreact',
    js: 'javascript',
    jsx: 'javascriptreact',
    py: 'python',
    go: 'go',
    rs: 'rust',
    c: 'c',
    cpp: 'cpp',
    h: 'c',
    hpp: 'cpp',
    java: 'java',
    jar: 'java',
    class: 'java',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    swift: 'swift',
    kt: 'kotlin',
    scala: 'scala',
    dart: 'dart',
    lua: 'lua',
    sh: 'shellscript',
    bash: 'shellscript',
    json: 'json',
    yaml: 'yaml',
    yml: 'yaml',
    xml: 'xml',
    html: 'html',
    css: 'css',
    scss: 'scss',
    vue: 'vue',
    svelte: 'svelte',
    tf: 'terraform',
    sql: 'sql',
    graphql: 'graphql',
    gql: 'graphql',
    md: 'markdown',
    tex: 'latex',
    elm: 'elm',
    hs: 'haskell',
    ml: 'ocaml',
    clj: 'clojure',
    fs: 'fsharp',
    r: 'r',
    toml: 'toml',
    zig: 'zig',
  };

  return languageMap[extension || ''] || 'plaintext';
}
