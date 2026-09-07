import { createHash, randomBytes } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { lstat, open, readFile, realpath, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { PreparedRewrite, RewriteRollback } from './ast/types.js';
import { logger } from './logger.js';
import type { LSPClient } from './lsp-client.js';
import { uriToPath } from './utils.js';

export interface TextEdit {
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  newText: string;
}

export interface WorkspaceEdit {
  changes?: Record<string, TextEdit[]>;
}

export interface ApplyEditResult {
  success: boolean;
  filesModified: string[];
  backupFiles: string[];
  error?: string;
  rollbackFailures?: string[];
}

export type AtomicRewriteStage =
  | 'before-preflight'
  | 'before-temp-write'
  | 'before-rename'
  | 'before-forward-sync'
  | 'before-forward-invalidate'
  | 'before-rollback-write'
  | 'before-rollback-sync'
  | 'before-rollback-invalidate';

export interface AtomicRewriteHooks {
  synchronize(files: Array<{ path: string; content: string }>): Promise<void>;
  invalidate(paths: string[]): Promise<void>;
  inject?(stage: AtomicRewriteStage, file?: string, index?: number): void | Promise<void>;
}

export interface AtomicRewriteResult {
  success: boolean;
  filesModified: string[];
  rollback: RewriteRollback;
  code?: 'AST_REWRITE_STALE' | 'AST_REWRITE_TRANSACTION_FAILED';
  error?: string;
}

function bufferSha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

async function writeOwnedTemp(path: string, content: Buffer, mode: number): Promise<void> {
  let created = false;
  try {
    const handle = await open(path, 'wx', mode & 0o7777);
    created = true;
    try {
      await handle.writeFile(content);
      await handle.chmod(mode & 0o7777);
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (created) await unlink(path).catch(() => undefined);
    throw error;
  }
}

function rewriteTempPath(target: string): string {
  return `${target}.cclsp-rewrite-${process.pid}-${randomBytes(8).toString('hex')}.tmp`;
}

async function assertCanonicalRewriteTarget(path: string): Promise<void> {
  const [canonicalTarget, canonicalParent] = await Promise.all([
    realpath(path),
    realpath(dirname(path)),
  ]);
  if (canonicalTarget !== path || canonicalParent !== dirname(path)) {
    throw new Error(`unsafe rewrite target changed canonical path: ${path}`);
  }
}

export async function applyAtomicRewrite(
  prepared: PreparedRewrite,
  hooks: AtomicRewriteHooks
): Promise<AtomicRewriteResult> {
  const files = [...prepared.files].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const tempPaths = new Map<string, string>();
  const replaced: typeof files = [];
  const failedFiles = new Set<string>();
  let mutationStarted = false;

  try {
    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file) continue;
      await hooks.inject?.('before-preflight', file.absolutePath, index);
      await assertCanonicalRewriteTarget(file.absolutePath);
      const fileStat = await lstat(file.absolutePath);
      if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
        throw new Error(`unsafe rewrite target: ${file.absolutePath}`);
      }
      const current = await readFile(file.absolutePath);
      if (bufferSha256(current) !== file.originalSha256) {
        const stale = new Error(`rewrite target changed: ${file.absolutePath}`);
        stale.name = 'AST_REWRITE_STALE';
        throw stale;
      }
    }

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file) continue;
      await hooks.inject?.('before-temp-write', file.absolutePath, index);
      await assertCanonicalRewriteTarget(file.absolutePath);
      const tempPath = rewriteTempPath(file.absolutePath);
      await writeOwnedTemp(tempPath, file.output, file.mode);
      tempPaths.set(file.absolutePath, tempPath);
    }

    for (let index = 0; index < files.length; index++) {
      const file = files[index];
      if (!file) continue;
      await hooks.inject?.('before-rename', file.absolutePath, index);
      await assertCanonicalRewriteTarget(file.absolutePath);
      const current = await readFile(file.absolutePath);
      if (bufferSha256(current) !== file.originalSha256) {
        const stale = new Error(`rewrite target changed: ${file.absolutePath}`);
        stale.name = 'AST_REWRITE_STALE';
        throw stale;
      }
      const tempPath = tempPaths.get(file.absolutePath);
      if (!tempPath) throw new Error(`missing prepared temp for ${file.absolutePath}`);
      await rename(tempPath, file.absolutePath);
      tempPaths.delete(file.absolutePath);
      replaced.push(file);
      mutationStarted = true;
    }

    if (files.length > 0) {
      await hooks.inject?.('before-forward-sync');
      await hooks.synchronize(
        files.map((file) => ({ path: file.absolutePath, content: file.output.toString('utf8') }))
      );
      await hooks.inject?.('before-forward-invalidate');
      await hooks.invalidate(files.map((file) => file.absolutePath));
    }
    return {
      success: true,
      filesModified: files.map((file) => file.absolutePath),
      rollback: {
        attempted: false,
        disk: 'not-needed',
        providers: 'not-needed',
        failedFiles: [],
      },
    };
  } catch (error) {
    const rollback: RewriteRollback = {
      attempted: mutationStarted,
      disk: mutationStarted ? 'complete' : 'not-needed',
      providers: mutationStarted ? 'complete' : 'not-needed',
      failedFiles: [],
    };
    if (mutationStarted) {
      for (let index = replaced.length - 1; index >= 0; index--) {
        const file = replaced[index];
        if (!file) continue;
        try {
          await hooks.inject?.('before-rollback-write', file.absolutePath, index);
          await assertCanonicalRewriteTarget(file.absolutePath);
          const restorePath = rewriteTempPath(file.absolutePath);
          try {
            await writeOwnedTemp(restorePath, file.original, file.mode);
            await rename(restorePath, file.absolutePath);
          } finally {
            await unlink(restorePath).catch(() => undefined);
          }
        } catch {
          rollback.disk = 'failed';
          failedFiles.add(file.absolutePath);
        }
      }
      let providerRollbackFailed = false;
      try {
        await hooks.inject?.('before-rollback-sync');
        await hooks.synchronize(
          files.map((file) => ({
            path: file.absolutePath,
            content: file.original.toString('utf8'),
          }))
        );
      } catch {
        providerRollbackFailed = true;
      }
      try {
        await hooks.inject?.('before-rollback-invalidate');
        await hooks.invalidate(files.map((file) => file.absolutePath));
      } catch {
        providerRollbackFailed = true;
      }
      if (providerRollbackFailed) {
        rollback.providers = 'failed';
        for (const file of files) failedFiles.add(file.absolutePath);
      }
    }
    rollback.failedFiles = [...failedFiles].sort();
    return {
      success: false,
      filesModified: [],
      rollback,
      code:
        error instanceof Error && error.name === 'AST_REWRITE_STALE'
          ? 'AST_REWRITE_STALE'
          : 'AST_REWRITE_TRANSACTION_FAILED',
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await Promise.all([...tempPaths.values()].map((path) => unlink(path).catch(() => undefined)));
  }
}

interface FileBackup {
  originalPath: string; // The path that was requested (could be symlink)
  targetPath: string; // The actual file path (resolved symlink target or same as originalPath)
  backupPath?: string;
  originalContent: string;
}

/**
 * Apply a workspace edit to files on disk
 * @param workspaceEdit The edit to apply (from LSP rename operation)
 * @param options Configuration options
 * @returns Result indicating success and modified files
 */
export async function applyWorkspaceEdit(
  workspaceEdit: WorkspaceEdit,
  options: {
    createBackups?: boolean;
    validateBeforeApply?: boolean;
    backupSuffix?: string;
    lspClient?: LSPClient;
  } = {}
): Promise<ApplyEditResult> {
  const paths = Object.keys(workspaceEdit.changes ?? {}).map(uriToPath);
  return options.lspClient
    ? options.lspClient.withDocumentWriteScopes(paths, () =>
        applyWorkspaceEditUnderScope(workspaceEdit, options)
      )
    : applyWorkspaceEditUnderScope(workspaceEdit, options);
}

async function applyWorkspaceEditUnderScope(
  workspaceEdit: WorkspaceEdit,
  options: {
    createBackups?: boolean;
    validateBeforeApply?: boolean;
    backupSuffix?: string;
    lspClient?: LSPClient;
  } = {}
): Promise<ApplyEditResult> {
  const {
    createBackups = true,
    validateBeforeApply = true,
    backupSuffix = '.bak',
    lspClient,
  } = options;

  const backups: FileBackup[] = [];
  const filesModified: string[] = [];

  if (!workspaceEdit.changes || Object.keys(workspaceEdit.changes).length === 0) {
    return {
      success: true,
      filesModified: [],
      backupFiles: [],
    };
  }

  try {
    // Pre-flight checks
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      const filePath = uriToPath(uri);

      // Check file exists
      if (!existsSync(filePath)) {
        throw new Error(`File does not exist: ${filePath}`);
      }

      // Check if it's a symlink and validate the target
      const stats = lstatSync(filePath);
      if (stats.isSymbolicLink()) {
        // For symlinks, validate that the target exists and is a file
        try {
          const realPath = realpathSync(filePath);
          const targetStats = statSync(realPath);
          if (!targetStats.isFile()) {
            throw new Error(`Symlink target is not a file: ${realPath}`);
          }
        } catch (error) {
          throw new Error(`Cannot resolve symlink ${filePath}: ${error}`);
        }
      } else if (!stats.isFile()) {
        // For non-symlinks, check it's a regular file
        throw new Error(`Not a file: ${filePath}`);
      }

      // Try to read the file to ensure we have permissions
      try {
        readFileSync(filePath, 'utf-8');
      } catch (error) {
        throw new Error(`Cannot read file: ${filePath} - ${error}`);
      }
    }

    // Process each file
    for (const [uri, edits] of Object.entries(workspaceEdit.changes)) {
      const originalPath = uriToPath(uri);

      // Resolve symlinks to their actual target
      let targetPath = originalPath;
      const originalStats = lstatSync(originalPath);
      if (originalStats.isSymbolicLink()) {
        targetPath = realpathSync(originalPath);
        logger.debug(`Editing symlink target: ${targetPath} (via ${originalPath})\n`);
      }

      // Read content from the actual file (symlink target or regular file)
      const originalContent = readFileSync(targetPath, 'utf-8');

      // Always track original content for rollback
      const backup: FileBackup = {
        originalPath: originalPath, // The requested path (could be symlink)
        targetPath: targetPath, // The actual file to restore
        originalContent,
      };

      // Create physical backup file if requested (backup the target, not the symlink)
      if (createBackups) {
        const backupPath = targetPath + backupSuffix;
        copyFileSync(targetPath, backupPath);
        backup.backupPath = backupPath;
      }

      backups.push(backup);

      // Apply edits to the file content
      const modifiedContent = applyEditsToContent(originalContent, edits, validateBeforeApply);

      // Write the modified content atomically to the target location
      const tempPath = `${targetPath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      writeFileSync(tempPath, modifiedContent, 'utf-8');

      // Atomic rename to replace the target file (not the symlink)
      try {
        renameSync(tempPath, targetPath);
      } catch (error) {
        // Clean up temp file if rename failed
        try {
          if (existsSync(tempPath)) {
            unlinkSync(tempPath);
          }
        } catch {}
        throw error;
      }

      // Report the original path as modified (what the user requested)
      filesModified.push(originalPath);

      // Sync the file with LSP server if client is provided
      // Use the original path (not target) for LSP sync since LSP tracks by requested path
      if (lspClient) {
        await lspClient.syncFileContent(originalPath);
      }
    }

    return {
      success: true,
      filesModified,
      backupFiles: backups
        .filter((b): b is FileBackup & { backupPath: string } => !!b.backupPath)
        .map((b) => b.backupPath),
    };
  } catch (error) {
    const rollbackFailures: string[] = [];
    for (const backup of backups) {
      try {
        // Restore to the target path (the actual file, not the symlink)
        writeFileSync(backup.targetPath, backup.originalContent, 'utf-8');
        if (lspClient) await lspClient.syncFileContent(backup.originalPath);
      } catch (rollbackError) {
        rollbackFailures.push(`${backup.originalPath}: ${String(rollbackError)}`);
      }
    }

    // Keep recovery bytes when any disk/provider restoration failed.
    for (const backup of rollbackFailures.length === 0 ? backups : []) {
      if (backup.backupPath) {
        try {
          if (existsSync(backup.backupPath)) {
            unlinkSync(backup.backupPath);
          }
        } catch (cleanupError) {
          console.error(`Failed to clean up backup ${backup.backupPath}:`, cleanupError);
        }
      }
    }

    return {
      success: false,
      filesModified: [],
      backupFiles:
        rollbackFailures.length > 0
          ? backups.flatMap((backup) => (backup.backupPath ? [backup.backupPath] : []))
          : [],
      error: error instanceof Error ? error.message : String(error),
      ...(rollbackFailures.length > 0 ? { rollbackFailures } : {}),
    };
  }
}

/**
 * Apply text edits to file content
 * @param content Original file content
 * @param edits List of edits to apply
 * @param validate Whether to validate edit positions
 * @returns Modified content
 */
function applyEditsToContent(content: string, edits: TextEdit[], validate: boolean): string {
  // Detect and preserve line ending style
  const lineEnding = content.includes('\r\n') ? '\r\n' : '\n';

  // Split content into lines for easier manipulation
  // Handle both LF and CRLF
  const lines = content.split(/\r?\n/);

  // Sort edits in reverse order (bottom to top, right to left)
  // This ensures that earlier edits don't affect the positions of later edits
  const sortedEdits = [...edits].sort((a, b) => {
    if (a.range.start.line !== b.range.start.line) {
      return b.range.start.line - a.range.start.line;
    }
    return b.range.start.character - a.range.start.character;
  });

  for (const edit of sortedEdits) {
    const { start, end } = edit.range;

    // Validate edit positions if requested
    if (validate) {
      if (start.line < 0 || start.line >= lines.length) {
        throw new Error(`Invalid start line ${start.line} (file has ${lines.length} lines)`);
      }
      if (end.line < 0 || end.line >= lines.length) {
        throw new Error(`Invalid end line ${end.line} (file has ${lines.length} lines)`);
      }

      // Validate start position is before end position
      if (start.line > end.line || (start.line === end.line && start.character > end.character)) {
        throw new Error(
          `Invalid range: start (${start.line}:${start.character}) is after end (${end.line}:${end.character})`
        );
      }

      // Validate character bounds for start line
      const startLine = lines[start.line];
      if (startLine !== undefined) {
        if (start.character < 0 || start.character > startLine.length) {
          throw new Error(
            `Invalid start character ${start.character} on line ${start.line} (line has ${startLine.length} characters)`
          );
        }
      }

      // Validate character bounds for end line
      const endLine = lines[end.line];
      if (endLine !== undefined) {
        if (end.character < 0 || end.character > endLine.length) {
          throw new Error(
            `Invalid end character ${end.character} on line ${end.line} (line has ${endLine.length} characters)`
          );
        }
      }
    }

    // Apply the edit
    if (start.line === end.line) {
      // Single line edit
      const line = lines[start.line];
      if (line !== undefined) {
        lines[start.line] =
          line.substring(0, start.character) + edit.newText + line.substring(end.character);
      }
    } else {
      // Multi-line edit
      const startLine = lines[start.line];
      const endLine = lines[end.line];

      if (startLine !== undefined && endLine !== undefined) {
        // Combine the parts with the new text
        const newLine =
          startLine.substring(0, start.character) + edit.newText + endLine.substring(end.character);

        // Replace the affected lines
        lines.splice(start.line, end.line - start.line + 1, newLine);
      }
    }
  }

  return lines.join(lineEnding);
}

/**
 * Clean up backup files created during editing
 * @param backupFiles List of backup file paths
 */
export function cleanupBackups(backupFiles: string[]): void {
  for (const backupPath of backupFiles) {
    try {
      if (existsSync(backupPath)) {
        unlinkSync(backupPath);
      }
    } catch (error) {
      console.error(`Failed to remove backup file ${backupPath}:`, error);
    }
  }
}
