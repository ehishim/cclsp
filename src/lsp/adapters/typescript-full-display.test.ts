// Full-display adapter reuses the provider Program rather than creating a parallel compiler.
import { expect, it } from 'bun:test';
import { createRequire } from 'node:module';
import ts from 'typescript';
const require = createRequire(import.meta.url);
const initialize = require('./typescript-full-display.cjs');

it('retains all inferred properties, documentation and ranges past quickinfo abbreviation', () => {
  const name = '/fixture.ts';
  const source = `/** Complete documentation. */\nexport function values() { return { ${Array.from({ length: 100 }, (_, i) => `field${i}: ${i}`).join(', ')} }; }`;
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => ({ noLib: true }),
    getScriptFileNames: () => [name],
    getScriptVersion: () => '1',
    getScriptSnapshot: (path) => (path === name ? ts.ScriptSnapshot.fromString(source) : undefined),
    getCurrentDirectory: () => '/',
    getDefaultLibFileName: () => '',
    fileExists: (path) => path === name,
    readFile: (path) => (path === name ? source : undefined),
  };
  const service = ts.createLanguageService(host);
  try {
    const position = source.indexOf('values');
    const original = service.getQuickInfoAtPosition(name, position);
    if (!original) throw new Error('quick info missing');
    const enriched = initialize({ typescript: ts })
      .create({ languageService: service })
      .getQuickInfoAtPosition(name, position);
    const display = ts.displayPartsToString(enriched.displayParts);
    for (let i = 0; i < 100; i++) expect(display).toContain(`field${i}: number`);
    expect(display).not.toContain('more');
    expect(enriched.documentation).toEqual(original.documentation);
    expect(enriched.textSpan).toEqual(original.textSpan);
    const untouched = initialize({ typescript: ts }).create({ languageService: service });
    const fieldPosition = source.indexOf('field0');
    const field = service.getQuickInfoAtPosition(name, fieldPosition);
    expect(untouched.getQuickInfoAtPosition(name, fieldPosition)).toEqual(field);
  } finally {
    service.dispose();
  }
});
