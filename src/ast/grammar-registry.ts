import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import Parser from 'web-tree-sitter';
import type { AstLanguage } from './types.js';

const require = createRequire(import.meta.url);
const RUNTIME_WASM = require.resolve('web-tree-sitter/tree-sitter.wasm');
const GRAMMAR_DIR = join(dirname(require.resolve('tree-sitter-wasms/package.json')), 'out');

const ASSET_BY_LANGUAGE: Record<AstLanguage, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  jsx: 'tree-sitter-javascript.wasm',
  python: 'tree-sitter-python.wasm',
  php: 'tree-sitter-php.wasm',
  go: 'tree-sitter-go.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
};

let initialization: Promise<void> | undefined;

function initializeParser(): Promise<void> {
  initialization ??= Parser.init({ locateFile: () => RUNTIME_WASM });
  return initialization;
}

export class GrammarRegistry {
  private parser: Parser | undefined;
  private readonly languages = new Map<string, Parser.Language>();
  private readonly loading = new Map<string, Promise<Parser.Language>>();
  private disposed = false;

  async getLanguage(language: AstLanguage): Promise<Parser.Language> {
    if (this.disposed) throw new Error('AST grammar registry is disposed');
    await initializeParser();
    const asset = ASSET_BY_LANGUAGE[language];
    const cached = this.languages.get(asset);
    if (cached) return cached;
    const pending = this.loading.get(asset);
    if (pending) return pending;

    const load = Parser.Language.load(join(GRAMMAR_DIR, asset))
      .then((loaded) => {
        this.languages.set(asset, loaded);
        return loaded;
      })
      .finally(() => this.loading.delete(asset));
    this.loading.set(asset, load);
    return load;
  }

  async parse(source: string, language: AstLanguage): Promise<Parser.Tree> {
    const grammar = await this.getLanguage(language);
    this.parser ??= new Parser();
    this.parser.setLanguage(grammar);
    return this.parser.parse(source);
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
  return join(GRAMMAR_DIR, ASSET_BY_LANGUAGE[language]);
}
