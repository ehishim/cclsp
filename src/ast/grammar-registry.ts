import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import { AST_LANGUAGE_DEFINITIONS, type AstLanguage } from './types.js';

const require = createRequire(import.meta.url);
const RUNTIME_WASM = require.resolve('web-tree-sitter/web-tree-sitter.wasm');
const GRAMMAR_DIR = join(
  dirname(require.resolve('@repomix/tree-sitter-wasms/package.json')),
  'out'
);

let initialization: Promise<void> | undefined;

function initializeParser(): Promise<void> {
  initialization ??= Parser.init({ locateFile: () => RUNTIME_WASM });
  return initialization;
}

export class GrammarRegistry {
  private parser: Parser | undefined;
  private readonly languages = new Map<string, Language>();
  private readonly loading = new Map<string, Promise<Language>>();
  private disposed = false;

  async getLanguage(language: AstLanguage): Promise<Language> {
    if (this.disposed) throw new Error('AST grammar registry is disposed');
    await initializeParser();
    const asset = grammarAssetPath(language);
    const cached = this.languages.get(asset);
    if (cached) return cached;
    const pending = this.loading.get(asset);
    if (pending) return pending;

    const load = Language.load(asset)
      .then((loaded) => {
        this.languages.set(asset, loaded);
        return loaded;
      })
      .finally(() => this.loading.delete(asset));
    this.loading.set(asset, load);
    return load;
  }

  async parse(source: string, language: AstLanguage): Promise<Tree> {
    const grammar = await this.getLanguage(language);
    this.parser ??= new Parser();
    this.parser.setLanguage(grammar);
    const tree = this.parser.parse(source);
    // The runtime returns null only when parsing was cancelled or the language
    // was never set; neither is reachable here, and a null tree must never be
    // mistaken for a file that contains nothing.
    if (!tree) throw new Error(`AST parse produced no tree for ${language}`);
    return tree;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.parser?.delete();
    this.parser = undefined;
    this.languages.clear();
    this.loading.clear();
  }
}

export function grammarAssetPath(language: AstLanguage): string {
  const definition = AST_LANGUAGE_DEFINITIONS[language];
  if (!('ownedAsset' in definition)) return join(GRAMMAR_DIR, definition.grammarAsset);
  let root = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(root, 'package.json'))) {
    const parent = dirname(root);
    if (parent === root) throw new Error('Cannot locate cclsp grammar assets');
    root = parent;
  }
  return join(root, 'grammars', definition.ownedAsset);
}
