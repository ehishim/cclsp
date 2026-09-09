import { lstat, readdir, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Ignore } from 'ignore';
import { loadGitignore } from '../file-scanner.js';
import {
  AST_LANGUAGE_DEFINITIONS,
  AST_MAX_FILE_BYTES,
  AST_TREE_CACHE_BYTES,
  AST_TREE_CACHE_FILES,
  type AstLanguage,
  type CachedTree,
  type IndexedDirectory,
  type IndexedFile,
  type WorkspaceSnapshot,
} from './types.js';

// Derived from the one language owner, so an added language never needs a second
// table to be updated in step.
const LANGUAGE_BY_EXTENSION: Record<string, AstLanguage> = Object.fromEntries(
  Object.entries(AST_LANGUAGE_DEFINITIONS).flatMap(([language, definition]) =>
    definition.extensions.map((extension) => [extension, language as AstLanguage])
  )
);

interface ScanResult {
  files: IndexedFile[];
  oversizedFiles: IndexedFile[];
  directories: Map<string, IndexedDirectory>;
  capped: boolean;
}

function normalizedRelative(path: string): string {
  return path.split(sep).join('/');
}

function isContained(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

function pathIsWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${sep}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function languageForPath(path: string): AstLanguage | undefined {
  return LANGUAGE_BY_EXTENSION[extname(path).toLowerCase()];
}

export class WorkspaceIndex {
  readonly root: string;
  private readonly ignoreFilter: Ignore;
  private snapshot: WorkspaceSnapshot | undefined;
  private buildInFlight: Promise<WorkspaceSnapshot> | undefined;
  private refreshInFlight: Promise<WorkspaceSnapshot> | undefined;
  private generation = 0;
  private readonly cache = new Map<string, CachedTree>();
  private cacheBytes = 0;
  private cacheClock = 0;

  private constructor(root: string, ignoreFilter: Ignore) {
    this.root = root;
    this.ignoreFilter = ignoreFilter;
  }

  static async create(root: string): Promise<WorkspaceIndex> {
    const canonicalRoot = await realpath(root);
    return new WorkspaceIndex(canonicalRoot, await loadGitignore(canonicalRoot));
  }

  async resolveSearchPath(input?: string): Promise<string> {
    const candidate = input ? (isAbsolute(input) ? input : join(this.root, input)) : this.root;
    let canonical: string;
    try {
      canonical = await realpath(candidate);
    } catch {
      throw new Error(`AST_PATH_INVALID:${candidate}`);
    }
    if (!isContained(this.root, canonical)) {
      throw new Error(`AST_PATH_ESCAPED:${candidate}`);
    }
    return canonical;
  }

  async resolveRewritePath(input?: string): Promise<string> {
    const candidate = resolve(
      input ? (isAbsolute(input) ? input : join(this.root, input)) : this.root
    );
    if (!isContained(this.root, candidate)) {
      throw new Error(`AST_PATH_ESCAPED:${candidate}`);
    }
    const relativeCandidate = normalizedRelative(relative(this.root, candidate));
    if (relativeCandidate && this.ignoreFilter.ignores(relativeCandidate)) {
      throw new Error(`AST_REWRITE_TARGET_UNSAFE:${candidate} is ignored or generated output`);
    }
    try {
      let current = this.root;
      for (const part of relative(this.root, candidate).split(sep).filter(Boolean)) {
        current = join(current, part);
        if ((await lstat(current)).isSymbolicLink()) {
          throw new Error(`AST_REWRITE_TARGET_UNSAFE:${candidate} traverses a symbolic link`);
        }
      }
      const canonical = await realpath(candidate);
      if (!isContained(this.root, canonical)) {
        throw new Error(`AST_PATH_ESCAPED:${candidate}`);
      }
      const candidateStat = await lstat(canonical);
      if (!candidateStat.isFile() && !candidateStat.isDirectory()) {
        throw new Error(
          `AST_REWRITE_TARGET_UNSAFE:${candidate} is not a regular file or directory`
        );
      }
      return canonical;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('AST_')) throw error;
      throw new Error(`AST_PATH_INVALID:${candidate}`);
    }
  }

  async getRewriteFiles(
    scope: string,
    language: AstLanguage
  ): Promise<{ files: IndexedFile[]; capped: boolean; explicitFile: boolean }> {
    const scopeStat = await lstat(scope);
    if (scopeStat.isFile()) {
      const fileLanguage = languageForPath(scope);
      if (!fileLanguage || !this.matchesLanguage(fileLanguage, language)) {
        throw new Error('AST_PATH_INVALID:Requested file does not match the requested language');
      }
      const fileStat = await stat(scope);
      return {
        files: [
          {
            absolutePath: scope,
            relativePath: normalizedRelative(relative(this.root, scope)),
            language: fileLanguage,
            bytes: fileStat.size,
            mtimeMs: fileStat.mtimeMs,
          },
        ],
        capped: false,
        explicitFile: true,
      };
    }
    if (!scopeStat.isDirectory()) {
      throw new Error('AST_PATH_INVALID:AST path must be a file or directory');
    }
    const snapshot = await this.ensureScope(scope);
    return {
      files: this.allFilesFor(snapshot, scope, language),
      capped: snapshot.capped,
      explicitFile: false,
    };
  }

  /** Scope discovery before loading unrelated project files into an explicit subtree query. */
  async ensureScope(scope: string): Promise<WorkspaceSnapshot> {
    if (resolve(scope) === this.root) return this.ensure();
    if (!isContained(this.root, resolve(scope)))
      throw new Error('AST_PATH_ESCAPED:scope is outside root');
    const scanned = await this.scanSubtree(scope, Number.POSITIVE_INFINITY);
    const entries = [...scanned.files, ...scanned.oversizedFiles].sort((a, b) =>
      compareText(a.relativePath, b.relativePath)
    );
    return {
      files: entries.filter((file) => file.bytes <= AST_MAX_FILE_BYTES),
      oversizedFiles: entries.filter((file) => file.bytes > AST_MAX_FILE_BYTES),
      directories: scanned.directories,
      capped: scanned.capped,
      generation: this.generation,
    };
  }

  async ensure(): Promise<WorkspaceSnapshot> {
    if (!this.snapshot) {
      this.buildInFlight ??= this.rebuild().finally(() => {
        this.buildInFlight = undefined;
      });
      return this.buildInFlight;
    }
    this.refreshInFlight ??= this.refreshStructure().finally(() => {
      this.refreshInFlight = undefined;
    });
    return this.refreshInFlight;
  }

  allFilesFor(snapshot: WorkspaceSnapshot, scope: string, language: AstLanguage): IndexedFile[] {
    return [...snapshot.files, ...snapshot.oversizedFiles]
      .filter(
        (file) =>
          pathIsWithin(scope, file.absolutePath) && this.matchesLanguage(file.language, language)
      )
      .sort((a, b) => compareText(a.relativePath, b.relativePath));
  }

  getCachedTree(path: string, language: AstLanguage, contentHash: string): CachedTree | undefined {
    const key = `${path}\0${language}`;
    const cached = this.cache.get(key);
    if (!cached || cached.contentHash !== contentHash) return undefined;
    cached.lastUsed = ++this.cacheClock;
    this.cache.delete(key);
    this.cache.set(key, cached);
    return cached;
  }

  setCachedTree(
    entry: Omit<CachedTree, 'lastUsed' | 'key'> & { path: string },
    language: AstLanguage
  ): CachedTree {
    const { path, ...treeEntry } = entry;
    const mapKey = `${path}\0${language}`;
    const previous = this.cache.get(mapKey);
    if (previous) this.deleteCacheEntry(mapKey, previous);
    const cached: CachedTree = { ...treeEntry, key: mapKey, lastUsed: ++this.cacheClock };
    this.cache.set(mapKey, cached);
    this.cacheBytes += cached.bytes;
    this.evictCache();
    return cached;
  }

  invalidate(path: string): void {
    const absolute = resolve(this.root, path);
    if (!isContained(this.root, absolute)) return;
    for (const [key, entry] of this.cache) {
      const entryPath = key.slice(0, key.indexOf('\0'));
      if (pathIsWithin(absolute, entryPath)) this.deleteCacheEntry(key, entry);
    }
  }

  dispose(): void {
    for (const [key, entry] of this.cache) this.deleteCacheEntry(key, entry);
    this.snapshot = undefined;
  }

  private matchesLanguage(fileLanguage: AstLanguage, requested: AstLanguage): boolean {
    if (requested === 'javascript') return fileLanguage === 'javascript';
    if (requested === 'jsx') return fileLanguage === 'jsx';
    return fileLanguage === requested;
  }

  private async rebuild(): Promise<WorkspaceSnapshot> {
    const scanned = await this.scanSubtree(this.root, Number.POSITIVE_INFINITY);
    const entries = [...scanned.files, ...scanned.oversizedFiles].sort((a, b) =>
      compareText(a.relativePath, b.relativePath)
    );
    this.snapshot = {
      files: entries.filter((file) => file.bytes <= AST_MAX_FILE_BYTES),
      oversizedFiles: entries.filter((file) => file.bytes > AST_MAX_FILE_BYTES),
      directories: scanned.directories,
      capped: scanned.capped,
      generation: ++this.generation,
    };
    return this.snapshot;
  }

  private async refreshStructure(): Promise<WorkspaceSnapshot> {
    const current = this.snapshot;
    if (!current) return this.rebuild();
    const changed: IndexedDirectory[] = [];
    for (const directory of current.directories.values()) {
      try {
        const currentStat = await stat(directory.absolutePath, { bigint: true });
        const entries = (await readdir(directory.absolutePath, { withFileTypes: true })).sort(
          (a, b) => compareText(a.name, b.name)
        );
        const entrySignature = entries
          .map((entry) => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'}`)
          .join('\u0000');
        if (
          !currentStat.isDirectory() ||
          currentStat.mtimeNs !== directory.mtimeNs ||
          entrySignature !== directory.entrySignature
        ) {
          changed.push(directory);
        }
      } catch {
        changed.push(directory);
      }
    }
    if (changed.length === 0) return current;
    if (current.capped) return this.rebuild();

    const topmost = changed
      .sort((a, b) => a.relativePath.length - b.relativePath.length)
      .filter(
        (directory, index, all) =>
          !all
            .slice(0, index)
            .some((parent) => pathIsWithin(parent.absolutePath, directory.absolutePath))
      );
    let files = [...current.files];
    let oversizedFiles = [...current.oversizedFiles];
    const directories = new Map(current.directories);
    let capped = false;

    for (const changedDirectory of topmost) {
      files = files.filter(
        (file) => !pathIsWithin(changedDirectory.absolutePath, file.absolutePath)
      );
      oversizedFiles = oversizedFiles.filter(
        (file) => !pathIsWithin(changedDirectory.absolutePath, file.absolutePath)
      );
      for (const [key, directory] of directories) {
        if (pathIsWithin(changedDirectory.absolutePath, directory.absolutePath))
          directories.delete(key);
      }
      let scanned: ScanResult;
      try {
        scanned = await this.scanSubtree(changedDirectory.absolutePath, Number.POSITIVE_INFINITY);
      } catch {
        continue;
      }
      files.push(...scanned.files);
      oversizedFiles.push(...scanned.oversizedFiles);
      for (const [key, directory] of scanned.directories) directories.set(key, directory);
      capped ||= scanned.capped;
    }

    const entries = [...files, ...oversizedFiles].sort((a, b) =>
      compareText(a.relativePath, b.relativePath)
    );
    this.snapshot = {
      files: entries.filter((file) => file.bytes <= AST_MAX_FILE_BYTES),
      oversizedFiles: entries.filter((file) => file.bytes > AST_MAX_FILE_BYTES),
      directories,
      capped,
      generation: ++this.generation,
    };
    return this.snapshot;
  }

  private async scanSubtree(start: string, limit: number): Promise<ScanResult> {
    const files: IndexedFile[] = [];
    const oversizedFiles: IndexedFile[] = [];
    const directories = new Map<string, IndexedDirectory>();
    let capped = false;

    const visit = async (directoryPath: string): Promise<void> => {
      if (files.length + oversizedFiles.length >= limit) {
        capped = true;
        return;
      }
      const directoryStat = await stat(directoryPath, { bigint: true });
      const directoryRelative = normalizedRelative(relative(this.root, directoryPath));
      const entries = (await readdir(directoryPath, { withFileTypes: true })).sort((a, b) =>
        compareText(a.name, b.name)
      );
      directories.set(directoryPath, {
        absolutePath: directoryPath,
        relativePath: directoryRelative,
        mtimeNs: directoryStat.mtimeNs,
        entrySignature: entries
          .map((entry) => `${entry.name}:${entry.isDirectory() ? 'd' : entry.isFile() ? 'f' : 'o'}`)
          .join('\u0000'),
      });
      for (const entry of entries) {
        if (files.length + oversizedFiles.length >= limit) {
          capped = true;
          return;
        }
        if (entry.isSymbolicLink()) continue;
        const absolutePath = join(directoryPath, entry.name);
        const relativePath = normalizedRelative(relative(this.root, absolutePath));
        if (this.ignoreFilter.ignores(entry.isDirectory() ? `${relativePath}/` : relativePath))
          continue;
        if (entry.isDirectory()) {
          await visit(absolutePath);
          continue;
        }
        if (!entry.isFile()) continue;
        const language = languageForPath(entry.name);
        if (!language) continue;
        const fileStat = await stat(absolutePath);
        const indexed: IndexedFile = {
          absolutePath,
          relativePath,
          language,
          bytes: fileStat.size,
          mtimeMs: fileStat.mtimeMs,
        };
        if (fileStat.size > AST_MAX_FILE_BYTES) oversizedFiles.push(indexed);
        else files.push(indexed);
      }
    };

    await visit(start);
    return { files, oversizedFiles, directories, capped };
  }

  private evictCache(): void {
    while (this.cache.size > AST_TREE_CACHE_FILES || this.cacheBytes > AST_TREE_CACHE_BYTES) {
      const oldest = this.cache.entries().next().value;
      if (!oldest) break;
      this.deleteCacheEntry(oldest[0], oldest[1]);
    }
  }

  private deleteCacheEntry(key: string, entry: CachedTree): void {
    if (!this.cache.delete(key)) return;
    this.cacheBytes -= entry.bytes;
    entry.tree.delete();
  }
}
