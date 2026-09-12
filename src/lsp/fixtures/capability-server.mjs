#!/usr/bin/env node

import { writeFileSync } from 'node:fs';

const supportsDocumentSymbols = process.argv.includes('--document-symbols');
const returnsEmptyDocumentSymbols = process.argv.includes('--empty-document-symbols');
const supportsLanguageFeatures = process.argv.includes('--language-features');
const markerArg = process.argv.find((arg) => arg.startsWith('--did-rename-marker='));
const didRenameMarker = markerArg?.slice('--did-rename-marker='.length);
const initializeMarkerArg = process.argv.find((arg) => arg.startsWith('--initialize-marker='));
const initializeMarker = initializeMarkerArg?.slice('--initialize-marker='.length);
let buffer = Buffer.alloc(0);

function send(message) {
  const body = Buffer.from(JSON.stringify(message));
  process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
  process.stdout.write(body);
}

function handle(message) {
  if (message.method === 'initialize' && message.id !== undefined) {
    if (initializeMarker) writeFileSync(initializeMarker, JSON.stringify(message.params));
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          ...(supportsDocumentSymbols ? { documentSymbolProvider: true } : {}),
          ...(supportsLanguageFeatures
            ? {
                completionProvider: {},
                signatureHelpProvider: {},
                codeActionProvider: true,
                workspace: {
                  fileOperations: {
                    willRename: {
                      filters: [{ scheme: 'file', pattern: { glob: '**/*.features' } }],
                    },
                    didRename: {
                      filters: [{ scheme: 'file', pattern: { glob: '**/*.features' } }],
                    },
                  },
                },
              }
            : {}),
        },
        serverInfo: {
          name: supportsDocumentSymbols ? 'fixture-supporting' : 'fixture-unsupported',
        },
      },
    });
    return;
  }
  if (message.method === 'initialized') {
    send({ jsonrpc: '2.0', method: 'initialized', params: {} });
    return;
  }
  if (message.method === 'textDocument/documentSymbol' && message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: supportsDocumentSymbols
        ? returnsEmptyDocumentSymbols
          ? []
          : [
              {
                name: 'fixtureSymbol',
                kind: 12,
                range: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 13 },
                },
                selectionRange: {
                  start: { line: 0, character: 0 },
                  end: { line: 0, character: 13 },
                },
              },
            ]
        : null,
    });
    return;
  }
  if (message.method === 'textDocument/completion' && message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: { isIncomplete: false, items: [{ label: 'fixtureCompletion', kind: 3 }] },
    });
    return;
  }
  if (message.method === 'textDocument/signatureHelp' && message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        signatures: [
          { label: 'fixtureCall(value: string): void', parameters: [{ label: 'value' }] },
        ],
        activeSignature: 0,
        activeParameter: 0,
      },
    });
    return;
  }
  if (message.method === 'textDocument/codeAction' && message.id !== undefined) {
    const uri = message.params?.textDocument?.uri;
    send({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        {
          title: 'Apply fixture edit',
          kind: 'quickfix',
          edit: {
            documentChanges: [
              {
                textDocument: { uri, version: null },
                edits: [
                  {
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
                    newText: 'updated',
                  },
                ],
              },
            ],
          },
        },
        { title: 'Command only', command: { title: 'Run fixture', command: 'fixture.run' } },
        {
          title: 'Resource operation',
          edit: {
            documentChanges: [{ kind: 'create', uri: `${uri}.created` }],
          },
        },
      ],
    });
    return;
  }
  if (message.method === 'workspace/willRenameFiles' && message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: { changes: {} } });
    return;
  }
  if (message.method === 'workspace/didRenameFiles') {
    if (didRenameMarker) writeFileSync(didRenameMarker, JSON.stringify(message.params));
    return;
  }
  if (message.method === 'shutdown' && message.id !== undefined) {
    send({ jsonrpc: '2.0', id: message.id, result: null });
    return;
  }
  if (message.method === 'exit') process.exit(0);
  if (message.id !== undefined) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32601, message: `Method not found: ${message.method}` },
    });
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;
    const header = buffer.subarray(0, headerEnd).toString('ascii');
    const match = /Content-Length:\s*(\d+)/i.exec(header);
    if (!match) process.exit(2);
    const length = Number(match[1]);
    const bodyStart = headerEnd + 4;
    if (buffer.length < bodyStart + length) break;
    const body = buffer.subarray(bodyStart, bodyStart + length).toString('utf8');
    buffer = buffer.subarray(bodyStart + length);
    handle(JSON.parse(body));
  }
});
