import { logger } from '../logger.js';
import type { Diagnostic } from './types.js';

/**
 * Cache for LSP diagnostics received via publishDiagnostics notifications.
 * Tracks diagnostic state per URI with version and timestamp tracking
 * to support idle detection for pull-based fallback.
 */
export class DiagnosticsCache {
  private diagnostics = new Map<string, Diagnostic[]>();
  private lastUpdate = new Map<string, number>();
  private versions = new Map<string, number>();

  /**
   * Update cached diagnostics for a URI (called from publishDiagnostics handler).
   */
  update(uri: string, items: Diagnostic[], version?: number): void {
    this.diagnostics.set(uri, items);
    this.lastUpdate.set(uri, Date.now());
    if (version !== undefined) {
      this.versions.set(uri, version);
    }
  }

  /**
   * Get cached diagnostics for a URI, or undefined if none cached.
   */
  get(uri: string): Diagnostic[] | undefined {
    return this.diagnostics.get(uri);
  }

  /**
   * Delete cached diagnostics for a URI.
   * Used to invalidate stale cache after file content changes.
   */
  delete(uri: string): void {
    this.diagnostics.delete(uri);
    this.lastUpdate.delete(uri);
    this.versions.delete(uri);
  }

  /**
   * Wait for diagnostics to stabilize (no updates for `idleTime` ms).
   * Used as fallback when textDocument/diagnostic is not supported.
   */
  async waitForIdle(
    uri: string,
    options: {
      maxWaitTime?: number;
      idleTime?: number;
      checkInterval?: number;
    } = {}
  ): Promise<void> {
    const { maxWaitTime = 1000, idleTime = 100, checkInterval = 50 } = options;

    const startTime = Date.now();
    let lastVersion = this.versions.get(uri) ?? -1;
    let lastUpdateTime = this.lastUpdate.get(uri) ?? startTime;

    logger.debug(
      `[DEBUG waitForDiagnosticsIdle] Waiting for diagnostics to stabilize for ${uri}\n`
    );

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      const currentVersion = this.versions.get(uri) ?? -1;
      const currentUpdateTime = this.lastUpdate.get(uri) ?? lastUpdateTime;

      if (currentVersion !== lastVersion) {
        logger.debug(
          `[DEBUG waitForDiagnosticsIdle] Version changed from ${lastVersion} to ${currentVersion}\n`
        );
        lastVersion = currentVersion;
        lastUpdateTime = currentUpdateTime;
        continue;
      }

      // Only apply idle detection after we've received at least one update.
      // Without this, we'd return immediately when the server simply hasn't
      // had time to analyze the file yet (e.g. workspace/configuration exchange).
      const hasReceivedUpdate = this.lastUpdate.has(uri);
      if (hasReceivedUpdate) {
        const timeSinceLastUpdate = Date.now() - currentUpdateTime;
        if (timeSinceLastUpdate >= idleTime) {
          logger.debug(
            `[DEBUG waitForDiagnosticsIdle] Server appears idle after ${timeSinceLastUpdate}ms without updates\n`
          );
          return;
        }
      }
    }

    logger.debug(`[DEBUG waitForDiagnosticsIdle] Max wait time reached (${maxWaitTime}ms)\n`);
  }

  /**
   * Wait for diagnostics to stabilize across ALL given URIs.
   * Returns when every URI that has received at least one update
   * has been idle for `idleTime` ms, or maxWaitTime is reached.
   */
  async waitForAllIdle(
    uris: string[],
    options: {
      maxWaitTime?: number;
      idleTime?: number;
      checkInterval?: number;
    } = {}
  ): Promise<void> {
    const { maxWaitTime = 15000, idleTime = 500, checkInterval = 50 } = options;

    const startTime = Date.now();
    const lastVersions = new Map<string, number>();
    for (const uri of uris) {
      lastVersions.set(uri, this.versions.get(uri) ?? -1);
    }

    logger.debug(
      `[DEBUG waitForAllIdle] Waiting for ${uris.length} URIs to stabilize\n`
    );

    while (Date.now() - startTime < maxWaitTime) {
      await new Promise((resolve) => setTimeout(resolve, checkInterval));

      let anyChanged = false;
      for (const uri of uris) {
        const currentVersion = this.versions.get(uri) ?? -1;
        const lastVersion = lastVersions.get(uri) ?? -1;
        if (currentVersion !== lastVersion) {
          lastVersions.set(uri, currentVersion);
          anyChanged = true;
        }
      }

      if (anyChanged) continue;

      // Check if at least one URI has received an update and all are idle
      const urisWithUpdates = uris.filter((uri) => this.lastUpdate.has(uri));
      if (urisWithUpdates.length === 0) continue;

      const allIdle = urisWithUpdates.every((uri) => {
        const lastUpdateTime = this.lastUpdate.get(uri) ?? 0;
        return Date.now() - lastUpdateTime >= idleTime;
      });

      if (allIdle) {
        logger.debug(
          `[DEBUG waitForAllIdle] All ${urisWithUpdates.length}/${uris.length} URIs stabilized\n`
        );
        return;
      }
    }

    logger.debug(`[DEBUG waitForAllIdle] Max wait time reached (${maxWaitTime}ms)\n`);
  }
}
