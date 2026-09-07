import { afterEach, beforeEach, describe, expect, it, jest } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocumentManager, getLanguageId } from './document-manager.js';
import type { JsonRpcTransport } from './json-rpc.js';

/** Write a file using Bun.write to avoid node:fs mock interference from other test files. */
async function writeFile(path: string, content: string): Promise<void> {
  await Bun.write(path, content);
}

let TEST_DIR: string;

function createMockTransport(): JsonRpcTransport & {
  sendNotification: ReturnType<typeof jest.fn>;
} {
  return {
    sendRequest: jest.fn(),
    sendMessage: jest.fn(),
    sendNotification: jest.fn(),
    rejectAllPending: jest.fn(),
  } as unknown as JsonRpcTransport & {
    sendNotification: ReturnType<typeof jest.fn>;
  };
}

async function openAndRelease(manager: DocumentManager, path: string): Promise<boolean> {
  const lease = await manager.acquire(path);
  const opened = lease.justOpened;
  lease.release();
  return opened;
}

describe('DocumentManager', () => {
  let transport: ReturnType<typeof createMockTransport>;
  let manager: DocumentManager;

  beforeEach(() => {
    TEST_DIR = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-test-'));
    transport = createMockTransport();
    manager = new DocumentManager(transport);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  describe('opening through a read lease', () => {
    it('opens a file and sends didOpen notification', async () => {
      const filePath = join(TEST_DIR, 'test.ts');
      await writeFile(filePath, 'const x = 1;');

      const result = await openAndRelease(manager, filePath);

      expect(result).toBe(true);
      expect(transport.sendNotification).toHaveBeenCalledTimes(1);
      expect(transport.sendNotification).toHaveBeenCalledWith('textDocument/didOpen', {
        textDocument: expect.objectContaining({
          languageId: 'typescript',
          version: 1,
          text: 'const x = 1;',
        }),
      });
    });

    it('returns false and does not re-send for already open file', async () => {
      const filePath = join(TEST_DIR, 'test.ts');
      await writeFile(filePath, 'const x = 1;');

      await openAndRelease(manager, filePath);
      const result = await openAndRelease(manager, filePath);

      expect(result).toBe(false);
      expect(transport.sendNotification).toHaveBeenCalledTimes(1);
    });

    it('throws when file does not exist', async () => {
      const filePath = join(TEST_DIR, 'nonexistent.ts');

      expect(openAndRelease(manager, filePath)).rejects.toThrow();
    });
  });

  describe('sendChange', () => {
    it('sends didChange with incremented version', async () => {
      const filePath = join(TEST_DIR, 'test.ts');
      await writeFile(filePath, 'const x = 1;');

      await openAndRelease(manager, filePath);
      await manager.withWriter(async () => manager.sendChange(filePath, 'const x = 2;'));

      expect(transport.sendNotification).toHaveBeenCalledWith('textDocument/didChange', {
        textDocument: expect.objectContaining({
          version: 2,
        }),
        contentChanges: [{ text: 'const x = 2;' }],
      });
    });

    it('increments version on each change', async () => {
      const filePath = join(TEST_DIR, 'test.ts');
      await writeFile(filePath, 'v1');

      await openAndRelease(manager, filePath);
      await manager.withWriter(async () => {
        manager.sendChange(filePath, 'v2');
        manager.sendChange(filePath, 'v3');
      });

      expect(manager.getVersion(filePath)).toBe(3);
    });
  });

  describe('isOpen', () => {
    it('returns false for unopened file', () => {
      expect(manager.isOpen('/some/file.ts')).toBe(false);
    });

    it('reports an open document after a read lease', async () => {
      const filePath = join(TEST_DIR, 'test.ts');
      await writeFile(filePath, 'content');

      await openAndRelease(manager, filePath);
      expect(manager.isOpen(filePath)).toBe(true);
    });
  });

  describe('getVersion', () => {
    it('returns 0 for unopened file', () => {
      expect(manager.getVersion('/some/file.ts')).toBe(0);
    });

    it('returns 1 after opening', async () => {
      const filePath = join(TEST_DIR, 'test.ts');
      await writeFile(filePath, 'content');

      await openAndRelease(manager, filePath);
      expect(manager.getVersion(filePath)).toBe(1);
    });
  });
});

describe('DocumentManager bounded lifecycle', () => {
  it('evicts and cleans up under Node 18 without Iterator Helpers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-lru-'));
    const first = join(root, 'first.ts');
    const second = join(root, 'second.ts');
    const third = join(root, 'third.ts');
    await Promise.all([
      writeFile(first, 'first'),
      writeFile(second, 'second'),
      writeFile(third, 'third'),
    ]);
    const transport = createMockTransport();
    const closed: string[] = [];
    const manager = new DocumentManager(transport, 2, (filePath) => closed.push(filePath));
    class Node18Map<K, V> extends Map<K, V> {
      override entries(): MapIterator<[K, V]> {
        const iterator = super.entries();
        Object.defineProperty(iterator, 'find', { value: undefined });
        return iterator;
      }
    }
    const internals = manager as unknown as { documents: Map<string, unknown> };
    internals.documents = new Node18Map(internals.documents);
    try {
      await openAndRelease(manager, first);
      await openAndRelease(manager, second);
      await openAndRelease(manager, first);
      await openAndRelease(manager, third);
      expect(manager.isOpen(first)).toBe(true);
      expect(manager.isOpen(second)).toBe(false);
      expect(manager.getVersion(second)).toBe(0);
      expect(manager.getSyncSig(second)).toBeUndefined();
      expect(closed).toEqual([second]);
      expect(transport.sendNotification).toHaveBeenCalledWith('textDocument/didClose', {
        textDocument: expect.objectContaining({ uri: expect.stringContaining('second.ts') }),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('preserves active documents and evicts after leases release', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-active-'));
    const first = join(root, 'first.ts');
    const second = join(root, 'second.ts');
    await Promise.all([writeFile(first, 'first'), writeFile(second, 'second')]);
    const manager = new DocumentManager(createMockTransport(), 1);
    try {
      const firstLease = await manager.acquire(first);
      const secondPending = manager.acquire(second);
      expect(manager.getOpenCount()).toBe(1);
      expect(manager.isOpen(first)).toBe(true);
      firstLease.release();
      const secondLease = await secondPending;
      expect(manager.getOpenCount()).toBe(1);
      expect(manager.isOpen(first)).toBe(false);
      expect(manager.isOpen(second)).toBe(true);
      secondLease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes an exclusive lease against earlier and later document users', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-exclusive-'));
    const file = join(root, 'example.ts');
    await writeFile(file, 'const value = target;\n');
    const manager = new DocumentManager(createMockTransport());
    try {
      const shared = await manager.acquire(file);
      let exclusiveAcquired = false;
      const pendingExclusive = manager.acquire(file, true).then((lease) => {
        exclusiveAcquired = true;
        return lease;
      });
      await Promise.resolve();
      expect(exclusiveAcquired).toBe(false);
      shared.release();
      const exclusive = await pendingExclusive;

      let laterAcquired = false;
      const pendingLater = manager.acquire(file).then((lease) => {
        laterAcquired = true;
        return lease;
      });
      await Promise.resolve();
      expect(laterAcquired).toBe(false);
      exclusive.release();
      const later = await pendingLater;
      expect(laterAcquired).toBe(true);
      later.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('serializes leases behind temporary content and rejects competing changes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-serialize-'));
    const file = join(root, 'example.ts');
    await writeFile(file, 'const value = target;\n');
    const manager = new DocumentManager(createMockTransport());
    try {
      await openAndRelease(manager, file);
      let finishTemporary: (() => void) | undefined;
      const temporaryAction = manager.withTemporaryContent(
        file,
        'const value = target.;\n',
        () =>
          new Promise<void>((resolve) => {
            finishTemporary = resolve;
          })
      );
      await Promise.resolve();
      expect(() => manager.sendChange(file, 'competing')).toThrow(
        'Cannot change a document while temporary content is active'
      );
      let acquired = false;
      const pendingLease = manager.acquire(file).then((lease) => {
        acquired = true;
        return lease;
      });
      await Promise.resolve();
      expect(acquired).toBe(false);
      finishTemporary?.();
      await temporaryAction;
      const lease = await pendingLease;
      expect(acquired).toBe(true);
      expect(manager.getText(file)).toBe('const value = target;\n');
      lease.release();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('restores exact in-memory text and increments versions after success and failure', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cclsp-docmgr-temp-'));
    const file = join(root, 'example.ts');
    await writeFile(file, 'const value = target;\n');
    const manager = new DocumentManager(createMockTransport());
    try {
      await openAndRelease(manager, file);
      await manager.withTemporaryContent(file, 'const value = target.;\n', async () => {
        expect(manager.getText(file)).toBe('const value = target.;\n');
      });
      expect(manager.getText(file)).toBe('const value = target;\n');
      expect(manager.getVersion(file)).toBe(3);
      await expect(
        manager.withTemporaryContent(file, 'temporary', async () => {
          throw new Error('request failed');
        })
      ).rejects.toThrow('request failed');
      expect(manager.getText(file)).toBe('const value = target;\n');
      expect(manager.getVersion(file)).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('getLanguageId', () => {
  it('maps TypeScript extensions', () => {
    expect(getLanguageId('file.ts')).toBe('typescript');
    expect(getLanguageId('file.tsx')).toBe('typescriptreact');
  });

  it('maps JavaScript extensions', () => {
    expect(getLanguageId('file.js')).toBe('javascript');
    expect(getLanguageId('file.jsx')).toBe('javascriptreact');
  });

  it('maps Python', () => {
    expect(getLanguageId('file.py')).toBe('python');
  });

  it('maps Go', () => {
    expect(getLanguageId('file.go')).toBe('go');
  });

  it('maps Vue and Svelte', () => {
    expect(getLanguageId('file.vue')).toBe('vue');
    expect(getLanguageId('file.svelte')).toBe('svelte');
  });

  it('returns plaintext for unknown extensions', () => {
    expect(getLanguageId('file.xyz')).toBe('plaintext');
    expect(getLanguageId('noextension')).toBe('plaintext');
  });

  it('handles paths with directories', () => {
    expect(getLanguageId('/src/components/App.tsx')).toBe('typescriptreact');
  });
});
