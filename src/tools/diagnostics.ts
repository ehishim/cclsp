import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { loadGitignore } from '../file-scanner.js';
import { resolvePath, textResult } from './helpers.js';
import type { ToolDefinition } from './registry.js';

export const getDiagnosticsTool: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    'Get language diagnostics (errors, warnings, hints) for a file. Uses LSP textDocument/diagnostic to pull current diagnostics.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to get diagnostics for',
      },
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path } = args as { file_path: string };
    const absolutePath = resolvePath(file_path);

    try {
      const diagnostics = await client.getDiagnostics(absolutePath);

      if (diagnostics.length === 0) {
        return textResult(
          `No diagnostics found for ${file_path}. The file has no errors, warnings, or hints.`
        );
      }

      return textResult(formatDiagnosticsForFile(file_path, diagnostics));
    } catch (error) {
      return textResult(
        `Error getting diagnostics: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

export const getDiagnosticsBatchTool: ToolDefinition = {
  name: 'get_diagnostics_batch',
  description:
    'Get language diagnostics for multiple files at once. Accepts a directory path with optional file pattern filter. Much faster than calling get_diagnostics repeatedly because files are opened in batch and diagnostics are collected in a single wait cycle.',
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Directory path to scan for files, or a single file path. Respects .gitignore.',
      },
      pattern: {
        type: 'string',
        description:
          'Regex pattern to filter file names (e.g. "\\.tsx?$" for .ts/.tsx files, "Controller\\.php$" for PHP controllers). Applied to the full relative path from the scanned directory.',
      },
      severity_filter: {
        type: 'string',
        enum: ['error', 'warning', 'info', 'hint'],
        description:
          'Minimum severity to include. "error" shows only errors, "warning" shows errors+warnings, etc. Default: show all.',
      },
      max_files: {
        type: 'number',
        description: 'Maximum number of files to scan. Default: 50. Max: 200.',
      },
    },
    required: ['path'],
  },
  handler: async (args, client) => {
    const { path: inputPath, pattern, severity_filter, max_files } = args as {
      path: string;
      pattern?: string;
      severity_filter?: string;
      max_files?: number;
    };

    const absolutePath = resolve(inputPath);
    const maxFiles = Math.min(max_files ?? 50, 200);

    try {
      // Check if path is a file or directory
      const pathStat = await stat(absolutePath);

      let filePaths: string[];

      if (pathStat.isFile()) {
        filePaths = [absolutePath];
      } else if (pathStat.isDirectory()) {
        // Compile regex if provided
        let regex: RegExp | null = null;
        if (pattern) {
          try {
            regex = new RegExp(pattern);
          } catch {
            return textResult(`Invalid regex pattern: ${pattern}`);
          }
        }

        // Scan directory for files
        filePaths = await scanFilesRecursive(absolutePath, regex, maxFiles);

        if (filePaths.length === 0) {
          const patternMsg = pattern ? ` matching pattern "${pattern}"` : '';
          return textResult(`No files found in ${inputPath}${patternMsg}.`);
        }
      } else {
        return textResult(`Path is neither a file nor a directory: ${inputPath}`);
      }

      // Run batch diagnostics
      const results = await client.getDiagnosticsBatch(filePaths);

      // Apply severity filter
      const severityThreshold = severity_filter
        ? { error: 1, warning: 2, info: 3, hint: 4 }[severity_filter] ?? 4
        : 4;

      let totalDiags = 0;
      let totalErrors = 0;
      let totalWarnings = 0;
      let totalInfo = 0;
      let totalHints = 0;

      const fileOutputs: string[] = [];

      for (const result of results) {
        const filtered = result.diagnostics.filter(
          (d) => (d.severity ?? 1) <= severityThreshold
        );

        if (filtered.length === 0) continue;

        // Count by severity
        for (const d of filtered) {
          switch (d.severity) {
            case 1:
              totalErrors++;
              break;
            case 2:
              totalWarnings++;
              break;
            case 3:
              totalInfo++;
              break;
            case 4:
              totalHints++;
              break;
            default:
              totalErrors++;
          }
        }
        totalDiags += filtered.length;

        // Format relative path for display
        const displayPath = pathStat.isDirectory()
          ? result.filePath.slice(absolutePath.length + 1)
          : result.filePath;

        fileOutputs.push(formatDiagnosticsForFile(displayPath, filtered));
      }

      if (totalDiags === 0) {
        const patternMsg = pattern ? ` matching "${pattern}"` : '';
        return textResult(
          `No diagnostics found across ${filePaths.length} file${filePaths.length === 1 ? '' : 's'}${patternMsg}. All clean!`
        );
      }

      // Build summary
      const severityParts: string[] = [];
      if (totalErrors > 0) severityParts.push(`${totalErrors} error${totalErrors === 1 ? '' : 's'}`);
      if (totalWarnings > 0) severityParts.push(`${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}`);
      if (totalInfo > 0) severityParts.push(`${totalInfo} info`);
      if (totalHints > 0) severityParts.push(`${totalHints} hint${totalHints === 1 ? '' : 's'}`);

      const filesWithDiags = fileOutputs.length;
      const summary = `Found ${totalDiags} diagnostic${totalDiags === 1 ? '' : 's'} across ${filesWithDiags}/${filePaths.length} files (${severityParts.join(', ')})`;
      const truncatedMsg =
        filePaths.length >= maxFiles
          ? `\n⚠️ Scanned max ${maxFiles} files. Increase max_files to scan more.`
          : '';

      return textResult(`${summary}${truncatedMsg}\n\n${fileOutputs.join('\n\n')}`);
    } catch (error) {
      return textResult(
        `Error getting batch diagnostics: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  },
};

// --- Helpers ---

const SEVERITY_MAP: Record<number, string> = {
  1: 'Error',
  2: 'Warning',
  3: 'Information',
  4: 'Hint',
};

function formatDiagnosticsForFile(
  displayPath: string,
  diagnostics: Array<{
    severity?: number;
    code?: string | number;
    source?: string;
    message: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  }>
): string {
  const header = `Found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} in ${displayPath}:`;

  const messages = diagnostics.map((diag) => {
    const severity = diag.severity ? SEVERITY_MAP[diag.severity] || 'Unknown' : 'Unknown';
    const code = diag.code ? ` [${diag.code}]` : '';
    const source = diag.source ? ` (${diag.source})` : '';
    const { start, end } = diag.range;

    return `• ${severity}${code}${source}: ${diag.message}\n  Location: Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}`;
  });

  return `${header}\n\n${messages.join('\n\n')}`;
}

// Supported extensions that LSP servers typically handle
const LSP_EXTENSIONS = new Set([
  'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'rs', 'c', 'cpp', 'h', 'hpp',
  'java', 'cs', 'php', 'rb', 'swift', 'kt', 'scala', 'dart', 'lua',
  'vue', 'svelte',
]);

async function scanFilesRecursive(
  dirPath: string,
  regex: RegExp | null,
  maxFiles: number,
  maxDepth = 10
): Promise<string[]> {
  const ig = await loadGitignore(dirPath);
  const files: string[] = [];

  async function walk(currentPath: string, depth: number, relativePath: string): Promise<void> {
    if (depth > maxDepth || files.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = await readdir(currentPath);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) return;

      const fullPath = join(currentPath, entry);
      const entryRelative = relativePath ? join(relativePath, entry) : entry;
      const normalized = entryRelative.replace(/\\/g, '/');

      if (ig.ignores(normalized)) continue;

      let entryStat;
      try {
        entryStat = await stat(fullPath);
      } catch {
        continue;
      }

      if (entryStat.isDirectory()) {
        await walk(fullPath, depth + 1, entryRelative);
      } else if (entryStat.isFile()) {
        const ext = extname(entry).toLowerCase().slice(1);
        if (!ext || !LSP_EXTENSIONS.has(ext)) continue;
        if (regex && !regex.test(normalized)) continue;
        files.push(fullPath);
      }
    }
  }

  await walk(dirPath, 0, '');
  return files;
}

export const diagnosticsTools: ToolDefinition[] = [getDiagnosticsTool, getDiagnosticsBatchTool];
