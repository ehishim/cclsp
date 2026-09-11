import { readdir, stat } from 'node:fs/promises';
import { extname, join, resolve } from 'node:path';
import { loadGitignore } from '../file-scanner.js';
import {
  SEMANTIC_DEFAULT_LIMIT,
  SEMANTIC_MAX_LIMIT,
  boundedResultLimit,
  resolvePath,
  textResult,
} from './helpers.js';
import type { ToolDefinition } from './registry.js';
import {
  PREVIEW_SCHEMA,
  type PreviewOption,
  type SourcePreview,
  createSourcePreview,
  previewWindow,
} from './source-preview.js';

export const getDiagnosticsTool: ToolDefinition = {
  name: 'get_diagnostics',
  description:
    'Check one file for errors, warnings and hints after editing it or its imports. Only a current result can establish that the file is clean; an unverified or unavailable result explains what to correct before retrying.',
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: 'The path to the file to get diagnostics for',
      },
      max_results: {
        type: 'number',
        description: `Rows to return (default ${SEMANTIC_DEFAULT_LIMIT}, max ${SEMANTIC_MAX_LIMIT})`,
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['file_path'],
  },
  handler: async (args, client) => {
    const { file_path, max_results, preview } = args as {
      file_path: string;
      max_results?: number;
      preview?: PreviewOption;
    };
    const absolutePath = resolvePath(file_path);
    // Created once per call: every diagnostic in this file reuses the same lines.
    const source = createSourcePreview(preview);

    try {
      const report = await client.getDiagnosticsReport(absolutePath);
      const allDiagnostics = report.diagnostics;
      const diagnostics = allDiagnostics.slice(0, boundedResultLimit(max_results));
      const omitted = allDiagnostics.length - diagnostics.length;
      if (report.freshness.status !== 'current') {
        return {
          content: [
            {
              type: 'text' as const,
              text: `${report.reason ?? 'Diagnostics are not current'}${diagnostics.length ? `\n${formatDiagnosticsForFile(file_path, diagnostics, absolutePath, source)}` : ''}`,
            },
          ],
          structuredContent: {
            outcome: 'stale',
            provider: 'lsp',
            code: 'LSP_DIAGNOSTICS_UNKNOWN',
            diagnostics,
            shown: diagnostics.length,
            total: null,
            omitted,
            freshness: report.freshness,
            recovery:
              'Retry after the reported write finishes, or use a request-capable diagnostics provider.',
          },
        };
      }
      const text =
        diagnostics.length === 0
          ? `No diagnostics found for ${file_path}. The file has no errors, warnings, or hints.`
          : `${formatDiagnosticsForFile(file_path, diagnostics, absolutePath, source)}${omitted > 0 ? `\n\n... ${omitted} omitted. Narrow the file or severity.` : ''}`;
      return {
        content: [{ type: 'text', text }],
        structuredContent: {
          outcome: diagnostics.length > 0 ? 'ok' : 'empty',
          provider: 'lsp',
          file: absolutePath,
          freshness: report.freshness,
          diagnostics,
          shown: diagnostics.length,
          total: allDiagnostics.length,
          omitted,
          recovery: omitted > 0 ? 'Narrow the diagnostic scope or severity.' : null,
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const details = error as {
        diagnostics?: import('../lsp/types.js').Diagnostic[];
        status?: string;
      };
      const stale =
        reason.startsWith('LSP_DIAGNOSTICS_UNKNOWN') || reason.startsWith('LSP_FRESHNESS_UNKNOWN');
      return {
        content: [
          {
            type: 'text',
            // Unverified rows are still rows about real code, so they carry the
            // same window: a caller told "these may be stale" still has to look at
            // what they point to, and dropping the source here would force exactly
            // the read this answer exists to avoid.
            text: `Error getting diagnostics: ${reason}${details.diagnostics?.length ? `\nUnverified provider rows:\n${formatDiagnosticsForFile(file_path, details.diagnostics, absolutePath, source)}` : ''}`,
          },
        ],
        structuredContent: {
          outcome: stale ? 'stale' : 'unavailable',
          provider: stale ? 'lsp' : 'none',
          code: stale ? reason.split(':')[0] : 'LSP_DIAGNOSTICS_UNAVAILABLE',
          reason,
          diagnostics: details.diagnostics ?? [],
          shown: details.diagnostics?.length ?? 0,
          total: null,
          omitted: 0,
          freshness: { status: details.status ?? 'unknown' },
        },
        isError: true,
      };
    }
  },
};

export const getDiagnosticsBatchTool: ToolDefinition = {
  name: 'get_diagnostics_batch',
  description:
    'Check a directory or file for errors, warnings and hints in one call. Filter paths to focus on the affected area. Results distinguish current diagnostics from unverified files and say when the file limit leaves more to check.',
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
        description:
          'Maximum number of files to scan. Default: 50 (CCLSP_MAX_FILES_DEFAULT). Max: 200 (CCLSP_MAX_FILES_LIMIT).',
      },
      preview: PREVIEW_SCHEMA,
    },
    required: ['path'],
  },
  handler: async (args, client) => {
    const {
      path: inputPath,
      pattern,
      severity_filter,
      max_files,
      preview,
    } = args as {
      path: string;
      pattern?: string;
      severity_filter?: string;
      max_files?: number;
      preview?: PreviewOption;
    };
    // One window owner for the whole call: every file is read at most once, and a
    // hundred diagnostics inside one file cost one read, not a hundred.
    const source = createSourcePreview(preview);

    const absolutePath = resolve(inputPath);
    // The per-call default (when max_files is omitted) and the upper bound are both
    // configurable for large repos. These live in cclsp core so the plain MCP server
    // and any wrapper (e.g. cclsp-hub) honor the same limits.
    const envInt = (v: string | undefined, def: number): number => {
      const n = Number.parseInt(v ?? '', 10);
      return Number.isFinite(n) && n > 0 ? n : def;
    };
    const ceiling = envInt(process.env.CCLSP_MAX_FILES_LIMIT, 200);
    const maxFiles = Math.min(
      max_files ?? envInt(process.env.CCLSP_MAX_FILES_DEFAULT, 50),
      ceiling
    );

    try {
      if (!Number.isInteger(maxFiles) || maxFiles < 1)
        throw new Error('max_files must be a positive integer');
      // Check if path is a file or directory
      const pathStat = await stat(absolutePath);

      let filePaths: string[];
      let truncated = false;

      if (pathStat.isFile()) {
        filePaths = [absolutePath];
      } else if (pathStat.isDirectory()) {
        // Compile regex if provided
        let regex: RegExp | null = null;
        if (pattern) {
          try {
            regex = new RegExp(pattern);
          } catch {
            throw new Error(`Invalid regex pattern: ${pattern}`);
          }
        }

        // Scan directory for files
        filePaths = await scanFilesRecursive(absolutePath, regex, maxFiles + 1);
        truncated = filePaths.length > maxFiles;
        filePaths = filePaths.slice(0, maxFiles);

        if (filePaths.length === 0) {
          const patternMsg = pattern ? ` matching pattern "${pattern}"` : '';
          return textResult(`No files found in ${inputPath}${patternMsg}.`);
        }
      } else {
        throw new Error(`Path is neither a file nor a directory: ${inputPath}`);
      }

      // Run batch diagnostics
      const severityThreshold = severity_filter
        ? ({ error: 1, warning: 2, info: 3, hint: 4 }[severity_filter] ?? 4)
        : 4;
      const results = (await client.getDiagnosticsBatch(filePaths)).map((result) => ({
        ...result,
        diagnostics: result.diagnostics.filter(
          (diagnostic) => (diagnostic.severity ?? 1) <= severityThreshold
        ),
      }));

      const uncertain = results.filter((result) => result.status && result.status !== 'current');
      if (uncertain.length > 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Diagnostics incomplete: ${uncertain.length}/${filePaths.length} files are unverified or unknown.\n${results.map((result) => `${result.filePath}: ${result.status ?? 'current'}${result.reason ? ` — ${result.reason}` : ''}${result.diagnostics.length ? `\n${formatDiagnosticsForFile(result.filePath, result.diagnostics, result.filePath, source)}` : ''}`).join('\n')}`,
            },
          ],
          structuredContent: {
            outcome: 'stale',
            provider: 'lsp',
            code: 'LSP_DIAGNOSTICS_UNKNOWN',
            files: results,
            shown: results.length,
            total: null,
            freshness: { status: 'unknown' },
            recovery:
              'Use a request-capable diagnostics provider; retry after any concurrent write completes.',
          },
        };
      }

      let totalDiags = 0;
      let totalErrors = 0;
      let totalWarnings = 0;
      let totalInfo = 0;
      let totalHints = 0;

      const fileOutputs: string[] = [];

      for (const result of results) {
        const filtered = result.diagnostics.filter((d) => (d.severity ?? 1) <= severityThreshold);

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

        fileOutputs.push(formatDiagnosticsForFile(displayPath, filtered, result.filePath, source));
      }

      if (totalDiags === 0) {
        const patternMsg = pattern ? ` matching "${pattern}"` : '';
        return {
          content: [
            {
              type: 'text' as const,
              text: `No diagnostics found across ${filePaths.length} file${filePaths.length === 1 ? '' : 's'}${patternMsg}.${truncated ? ' Scan reached the file limit; narrow the scope for complete coverage.' : ' All clean!'}`,
            },
          ],
          structuredContent: {
            outcome: truncated ? 'partial' : 'empty',
            provider: 'lsp',
            files: results,
            shown: 0,
            total: truncated ? null : 0,
            freshness: { status: 'current' },
            fileLimitReached: truncated,
          },
        };
      }

      // Build summary
      const severityParts: string[] = [];
      if (totalErrors > 0)
        severityParts.push(`${totalErrors} error${totalErrors === 1 ? '' : 's'}`);
      if (totalWarnings > 0)
        severityParts.push(`${totalWarnings} warning${totalWarnings === 1 ? '' : 's'}`);
      if (totalInfo > 0) severityParts.push(`${totalInfo} info`);
      if (totalHints > 0) severityParts.push(`${totalHints} hint${totalHints === 1 ? '' : 's'}`);

      const filesWithDiags = fileOutputs.length;
      const summary = `Found ${totalDiags} diagnostic${totalDiags === 1 ? '' : 's'} across ${filesWithDiags}/${filePaths.length} files (${severityParts.join(', ')})`;
      const truncatedMsg = truncated
        ? `\n⚠️ Scanned max ${maxFiles} files. Increase max_files to scan more.`
        : '';

      return {
        content: [
          {
            type: 'text' as const,
            text: `${summary}${truncatedMsg}\n\n${fileOutputs.join('\n\n')}`,
          },
        ],
        structuredContent: {
          outcome: truncated ? 'partial' : 'ok',
          provider: 'lsp',
          files: results,
          shown: totalDiags,
          total: truncated ? null : totalDiags,
          freshness: { status: 'current' },
        },
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        content: [{ type: 'text' as const, text: `Error getting batch diagnostics: ${reason}` }],
        structuredContent: {
          outcome: 'unavailable',
          provider: 'none',
          code: 'LSP_DIAGNOSTICS_UNAVAILABLE',
          reason,
          shown: 0,
          total: null,
        },
        isError: true,
      };
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

/**
 * A diagnostic without its source line is a message about code the reader cannot
 * see, so acting on it costs a file read every time. The offending line is the
 * cheapest possible answer to "what is actually written there", and it comes from
 * the same window owner every other location answer uses.
 */
function formatDiagnosticsForFile(
  displayPath: string,
  diagnostics: Array<{
    severity?: number;
    code?: string | number;
    source?: string;
    message: string;
    range: { start: { line: number; character: number }; end: { line: number; character: number } };
  }>,
  sourceFile?: string,
  source?: SourcePreview | null
): string {
  const header = `Found ${diagnostics.length} diagnostic${diagnostics.length === 1 ? '' : 's'} in ${displayPath}:`;

  const messages = diagnostics.map((diag) => {
    const severity = diag.severity ? SEVERITY_MAP[diag.severity] || 'Unknown' : 'Unknown';
    const code = diag.code ? ` [${diag.code}]` : '';
    const source_ = diag.source ? ` (${diag.source})` : '';
    const { start, end } = diag.range;
    const window =
      source && sourceFile ? previewWindow(source, sourceFile, start.line) : ([] as string[]);

    return [
      `• ${severity}${code}${source_}: ${diag.message}`,
      `  Location: Line ${start.line + 1}, Column ${start.character + 1} to Line ${end.line + 1}, Column ${end.character + 1}`,
      ...window,
    ].join('\n');
  });

  return `${header}\n\n${messages.join('\n\n')}`;
}

// Supported extensions that LSP servers typically handle
const LSP_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'py',
  'go',
  'rs',
  'c',
  'cpp',
  'h',
  'hpp',
  'java',
  'cs',
  'php',
  'rb',
  'swift',
  'kt',
  'scala',
  'dart',
  'lua',
  'vue',
  'svelte',
  'css',
  'scss',
  'less',
  'md',
  'markdown',
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

      let entryStat: Awaited<ReturnType<typeof stat>>;
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
