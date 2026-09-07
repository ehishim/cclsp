import { AsyncLocalStorage } from 'node:async_hooks';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { logger } from '../logger.js';
import { DEFAULT_MAX_OPEN_DOCUMENTS } from '../types.js';
import { pathToUri } from '../utils.js';
import type { JsonRpcTransport } from './json-rpc.js';

interface DocumentState {
  path: string;
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

export interface WriteScope {
  readonly epoch: number;
}
export interface DocumentSnapshot {
  epoch: number;
  contents: Map<string, string>;
  bytesCompared: number;
  resynced: string[];
  waitedFor: string[];
}

export class DocumentManager {
  private readonly documents = new Map<string, DocumentState>();
  private readonly temporaryDocuments = new Set<string>();
  private readonly leaseWaiters = new Map<string, Array<() => void>>();
  private readonly pendingExclusiveUses = new Map<string, number>();
  private readonly maxOpenDocuments: number;
  private syncEpoch = 0;
  private writer: WriteScope | null = null;
  private readonly writerContext = new AsyncLocalStorage<WriteScope>();
  private lockReaders = 0;
  private readonly lockQueue: Array<{ write: boolean; grant: () => void }> = [];
  private activeAdmissions = 0;
  private readonly admissionQueue: Array<{ count: number; grant: () => void }> = [];

  get capacity(): number {
    return this.maxOpenDocuments;
  }

  async acquireChunk(paths: string[]): Promise<DocumentLease[]> {
    if (this.writerContext.getStore())
      throw new Error('LSP_WRITE_SCOPE_INVALID: writers cannot acquire read leases');
    const unique = [...new Set(paths)];
    const releaseAdmission = await this.admit(unique.length);
    const leases: DocumentLease[] = [];
    try {
      for (const path of unique) leases.push(await this.acquireAdmitted(path));
      let remaining = leases.length;
      if (remaining === 0) releaseAdmission();
      return leases.map((lease) => {
        let released = false;
        return {
          justOpened: lease.justOpened,
          release: () => {
            if (released) return;
            released = true;
            lease.release();
            if (--remaining === 0) releaseAdmission();
          },
        };
      });
    } catch (error) {
      for (const lease of leases) lease.release();
      releaseAdmission();
      throw error;
    }
  }

  private admit(count: number): Promise<() => void> {
    if (count > this.maxOpenDocuments)
      return Promise.reject(
        new Error('LSP_ADMISSION_OVERSIZED: split diagnostic batch into capacity-sized chunks')
      );
    return new Promise((resolve, reject) => {
      const entry = {
        count,
        grant: () => {
          clearTimeout(timer);
          this.activeAdmissions += count;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            this.activeAdmissions -= count;
            this.drainAdmissions();
          });
        },
      };
      const timer = setTimeout(() => {
        const index = this.admissionQueue.indexOf(entry);
        if (index >= 0) this.admissionQueue.splice(index, 1);
        reject(new Error('LSP_ADMISSION_TIMEOUT: document capacity unavailable'));
        this.drainAdmissions();
      }, 30000);
      this.admissionQueue.push(entry);
      this.drainAdmissions();
    });
  }

  private drainAdmissions(): void {
    while (this.admissionQueue.length > 0) {
      const next = this.admissionQueue[0];
      if (!next) return;
      if (this.activeAdmissions + next.count > this.maxOpenDocuments) return;
      this.admissionQueue.shift();
      next.grant();
    }
  }

  get epoch(): number {
    return this.syncEpoch;
  }

  async withWriter<T>(action: (scope: WriteScope) => Promise<T>): Promise<T> {
    const owned = this.writerContext.getStore();
    if (owned !== undefined) {
      if (owned !== this.writer) throw new Error('LSP_WRITE_SCOPE_INVALID');
      return action(owned);
    }
    const release = await this.acquireSyncLock(true);
    const scope = Object.freeze({ epoch: this.syncEpoch });
    this.writer = scope;
    try {
      return await this.writerContext.run(scope, () => action(scope));
    } finally {
      this.writer = null;
      this.evictInactiveDocuments();
      release();
    }
  }

  async reconcile(): Promise<DocumentSnapshot> {
    if (this.writerContext.getStore())
      throw new Error('LSP_WRITE_SCOPE_INVALID: writers cannot reconcile');
    const waitedFor =
      this.writer !== null || this.lockQueue.length > 0 ? [...this.documents.keys()] : [];
    const releaseRead = await this.acquireSyncLock(false);
    const contents = new Map<string, string>();
    const resynced: string[] = [];
    let bytesCompared = 0;
    const epoch = this.syncEpoch;
    const updates: Array<{ path: string; text: string | null }> = [];
    try {
      for (const [path, state] of [...this.documents]) {
        let text: string;
        try {
          text = await readFile(path, 'utf8');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          updates.push({ path, text: null });
          continue;
        }
        bytesCompared += Buffer.byteLength(text);
        contents.set(path, text);
        if (text !== state.text) updates.push({ path, text });
      }
    } finally {
      releaseRead();
    }
    if (this.syncEpoch !== epoch)
      throw new Error('LSP_FRESHNESS_UNKNOWN: document state changed during reconciliation');
    if (updates.length > 0) {
      await this.withWriter(async (scope) => {
        if (this.syncEpoch !== epoch)
          throw new Error('LSP_FRESHNESS_UNKNOWN: document state changed during reconciliation');
        for (const { path, text } of updates) {
          if (text === null) {
            this.documents.delete(path);
            this.syncEpoch++;
            this.transport.sendNotification('textDocument/didClose', {
              textDocument: { uri: pathToUri(path) },
            });
            this.onClose?.(path);
          } else {
            this.changeUnderScope(path, text, scope);
          }
          resynced.push(path);
        }
      });
    }
    return { epoch: this.syncEpoch, contents, bytesCompared, resynced, waitedFor };
  }

  async changedSince(snapshot: DocumentSnapshot): Promise<string[]> {
    if (this.writerContext.getStore())
      throw new Error('LSP_WRITE_SCOPE_INVALID: writers cannot reconcile');
    const release = await this.acquireSyncLock(false);
    try {
      const changed: string[] = [];
      for (const [path, text] of snapshot.contents) {
        try {
          if ((await readFile(path, 'utf8')) !== text) changed.push(path);
        } catch {
          changed.push(path);
        }
      }
      if (snapshot.epoch !== this.syncEpoch && changed.length === 0)
        changed.push(...snapshot.contents.keys());
      return changed;
    } finally {
      release();
    }
  }

  changeUnderScope(path: string, text: string, scope: WriteScope): void {
    if (scope !== this.writer) throw new Error('LSP_WRITE_SCOPE_INVALID');
    this.sendChange(path, text);
  }

  private acquireSyncLock(write: boolean): Promise<() => void> {
    return new Promise((resolve, reject) => {
      const entry = {
        write,
        grant: () => {
          clearTimeout(timer);
          if (!write) this.lockReaders++;
          let released = false;
          resolve(() => {
            if (released) return;
            released = true;
            if (!write) this.lockReaders--;
            this.drainSyncLock();
          });
        },
      };
      const timer = setTimeout(() => {
        const index = this.lockQueue.indexOf(entry);
        if (index >= 0) this.lockQueue.splice(index, 1);
        reject(new Error('LSP_FRESHNESS_UNKNOWN: document writer did not finish within 5000ms'));
        this.drainSyncLock();
      }, 5000);
      this.lockQueue.push(entry);
      this.drainSyncLock();
    });
  }

  private drainSyncLock(): void {
    if (this.writer !== null) return;
    while (this.lockQueue.length > 0) {
      const next = this.lockQueue[0];
      if (!next) return;
      if (next.write) {
        if (this.lockReaders > 0) return;
        this.lockQueue.shift();
        // Reserve before resolving: another synchronous acquisition must queue.
        this.writer = Object.freeze({ epoch: this.syncEpoch });
        next.grant();
        return;
      }
      this.lockQueue.shift();
      next.grant();
    }
  }

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

  async acquire(filePath: string, exclusive = false): Promise<DocumentLease> {
    if (this.writerContext.getStore())
      throw new Error('LSP_WRITE_SCOPE_INVALID: writers cannot acquire read leases');
    const releaseAdmission = await this.admit(1);
    try {
      const lease = await this.acquireAdmitted(filePath, exclusive);
      let released = false;
      return {
        justOpened: lease.justOpened,
        release: () => {
          if (released) return;
          released = true;
          lease.release();
          releaseAdmission();
        },
      };
    } catch (error) {
      releaseAdmission();
      throw error;
    }
  }

  private async acquireAdmitted(filePath: string, exclusive = false): Promise<DocumentLease> {
    if (exclusive) {
      this.pendingExclusiveUses.set(filePath, (this.pendingExclusiveUses.get(filePath) ?? 0) + 1);
    }
    let state: DocumentState | undefined;
    let justOpened = false;
    try {
      while (true) {
        await this.waitForLease(filePath, exclusive);
        const releaseLock = await this.acquireSyncLock(false);
        state = this.documents.get(filePath);
        if (state && (state.exclusiveUse || (exclusive && state.activeUses > 0))) {
          releaseLock();
          continue;
        }
        try {
          justOpened = !state;
          if (!state) state = this.open(filePath, 1, exclusive);
          else {
            state.activeUses++;
            state.exclusiveUse = exclusive;
            this.touch(filePath, state);
          }
        } finally {
          releaseLock();
        }
        break;
      }
    } finally {
      if (exclusive) {
        const remaining = (this.pendingExclusiveUses.get(filePath) ?? 1) - 1;
        if (remaining > 0) this.pendingExclusiveUses.set(filePath, remaining);
        else this.pendingExclusiveUses.delete(filePath);
      }
    }
    this.evictInactiveDocuments();

    let released = false;
    return {
      justOpened,
      release: () => {
        if (released) return;
        released = true;
        const current = state;
        if (current) {
          current.activeUses = Math.max(0, current.activeUses - 1);
          if (exclusive) current.exclusiveUse = false;
          if (this.documents.get(current.path) === current) this.touch(current.path, current);
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
    if (this.writerContext.getStore() !== this.writer || this.writer === null)
      throw new Error('LSP_WRITE_SCOPE_INVALID');
    this.sendChangeInternal(filePath, text);
  }

  async withTemporaryContent<T>(
    filePath: string,
    temporaryText: string,
    action: () => Promise<T>
  ): Promise<T> {
    return this.withWriter(() => this.temporaryContentUnderScope(filePath, temporaryText, action));
  }

  private async temporaryContentUnderScope<T>(
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

  renameOpenDocument(oldPath: string, newPath: string, scope: WriteScope): void {
    if (scope !== this.writer) throw new Error('LSP_WRITE_SCOPE_INVALID');
    const previous = this.documents.get(oldPath);
    if (!previous) return;
    this.documents.delete(oldPath);
    this.syncEpoch++;
    this.transport.sendNotification('textDocument/didClose', {
      textDocument: { uri: pathToUri(oldPath) },
    });
    this.onClose?.(oldPath);
    const next = this.open(newPath, previous.activeUses);
    Object.assign(previous, next);
    this.documents.set(newPath, previous);
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
    this.syncEpoch++;
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
      await new Promise<void>((resolve, reject) => {
        const wake = () => {
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(() => {
          const waiters = this.leaseWaiters.get(filePath);
          const index = waiters?.indexOf(wake) ?? -1;
          if (index >= 0) waiters?.splice(index, 1);
          if (waiters?.length === 0) this.leaseWaiters.delete(filePath);
          reject(new Error('LSP_FRESHNESS_UNKNOWN: document lease did not release within 5000ms'));
        }, 5000);
        const waiters = this.leaseWaiters.get(filePath) ?? [];
        waiters.push(wake);
        this.leaseWaiters.set(filePath, waiters);
      });
    }
  }

  private open(filePath: string, activeUses: number, exclusiveUse = false): DocumentState {
    logger.debug(`[DEBUG ensureOpen] Opening file: ${filePath}\n`);
    const text = readFileSync(filePath, 'utf-8');
    const state: DocumentState = { path: filePath, version: 1, text, activeUses, exclusiveUse };
    this.documents.set(filePath, state);
    this.syncEpoch++;
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
    if (this.writer !== null || this.lockReaders > 0) return;
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
      this.syncEpoch++;
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
