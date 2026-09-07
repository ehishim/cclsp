// The owned grammars preserve valid TypeScript/JSX syntax and malformed-input detection.
import { describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { GrammarRegistry } from './grammar-registry.js';

describe('owned TypeScript grammars', () => {
  it('loads only the asset and patch bytes recorded by the build manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../grammars/manifest.json', import.meta.url), 'utf8')
    ) as {
      assets: Record<string, string>;
      patches: Record<string, string>;
    };
    for (const [directory, entries] of [
      ['grammars', manifest.assets],
      ['patches', manifest.patches],
    ] as const) {
      for (const [name, expected] of Object.entries(entries)) {
        const bytes = readFileSync(new URL(`../../${directory}/${name}`, import.meta.url));
        expect(createHash('sha256').update(bytes).digest('hex')).toBe(expected);
      }
    }
  });
  it('parses import types, type reexports and import queries without losing nodes', async () => {
    const registry = new GrammarRegistry();
    try {
      for (const language of ['typescript', 'tsx'] as const) {
        for (const source of [
          'export type X = import("m").T<string>[];',
          'export type * from "m";',
          'export type * as Types from "m";',
          'const x = fn<typeof import("m")>();',
        ]) {
          const tree = await registry.parse(source, language);
          try {
            expect(tree.rootNode.hasError).toBe(false);
          } finally {
            tree.delete();
          }
        }
        for (const source of [
          'export type *;',
          'export type * as X;',
          'type X = import("m").T<;',
        ]) {
          const tree = await registry.parse(source, language);
          try {
            expect(tree.rootNode.hasError).toBe(true);
          } finally {
            tree.delete();
          }
        }
      }
    } finally {
      registry.dispose();
    }
  });

  it('keeps bare ampersands as JSX text and entities as character references', async () => {
    const registry = new GrammarRegistry();
    try {
      const tree = await registry.parse(
        'const x = <button>Save & Allow &amp; &#65; &#x41; && &invalid</button>;',
        'tsx'
      );
      try {
        expect(tree.rootNode.hasError).toBe(false);
        expect(tree.rootNode.toString().match(/html_character_reference/g)).toHaveLength(3);
      } finally {
        tree.delete();
      }
    } finally {
      registry.dispose();
    }
  });
});
