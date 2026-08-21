import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LspToolOutcomeError } from './capabilities.js';
import { getDocumentSymbols } from './operations.js';
import { ServerManager } from './server-manager.js';

const fixtureServer = fileURLToPath(new URL('./fixtures/capability-server.mjs', import.meta.url));
const fixtureRoot = mkdtempSync(join(tmpdir(), 'cclsp-capability-server-'));
const fixtureFile = join(fixtureRoot, 'fixture.supported');
writeFileSync(fixtureFile, 'fixtureSymbol\n');
afterAll(() => rmSync(fixtureRoot, { recursive: true, force: true }));

describe('ServerManager initialize capabilities', () => {
  it('records declared capabilities and exposes a supported result', async () => {
    const manager = new ServerManager();
    try {
      const state = await manager.getServer({
        extensions: ['supported'],
        command: [process.execPath, fixtureServer, '--document-symbols'],
        rootDir: fixtureRoot,
      });
      expect(state.serverCapabilities).toMatchObject({ documentSymbolProvider: true });
      const symbols = await getDocumentSymbols(state, fixtureFile);
      expect(symbols).toHaveLength(1);
      expect(symbols[0]?.name).toBe('fixtureSymbol');
    } finally {
      await manager.dispose();
    }
  });

  it('records absence and rejects before sending an unsupported request', async () => {
    const manager = new ServerManager();
    try {
      const state = await manager.getServer({
        extensions: ['supported'],
        command: [process.execPath, fixtureServer],
        rootDir: fixtureRoot,
      });
      expect(state.serverCapabilities).not.toHaveProperty('documentSymbolProvider');
      await expect(getDocumentSymbols(state, fixtureFile)).rejects.toBeInstanceOf(
        LspToolOutcomeError
      );
    } finally {
      await manager.dispose();
    }
  });
});
