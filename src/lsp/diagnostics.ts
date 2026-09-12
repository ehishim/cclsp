import type { Diagnostic } from './types.js';

/** Push publications are observations, not proof of current dependency state. */
export class DiagnosticsCache {
  private readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly lastUpdate = new Map<string, number>();
  private readonly versions = new Map<string, number>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Map<string, Set<() => void>>();

  update(uri: string, items: Diagnostic[], version?: number): void {
    const previous = this.versions.get(uri);
    if (version !== undefined && previous !== undefined && version < previous) return;
    this.diagnostics.set(uri, items);
    this.lastUpdate.set(uri, Date.now());
    this.revisions.set(uri, (this.revisions.get(uri) ?? 0) + 1);
    if (version !== undefined) this.versions.set(uri, version);
    for (const listener of this.listeners.get(uri) ?? []) listener();
  }

  get(uri: string): Diagnostic[] | undefined {
    return this.diagnostics.get(uri);
  }

  revision(uri: string): number {
    return this.revisions.get(uri) ?? 0;
  }

  waitForUpdate(uri: string, afterRevision: number, maxWaitTime: number): Promise<boolean> {
    if (this.revision(uri) > afterRevision) return Promise.resolve(true);
    return new Promise((resolve) => {
      let finished = false;
      const finish = (updated: boolean) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        const listeners = this.listeners.get(uri);
        listeners?.delete(changed);
        if (listeners?.size === 0) this.listeners.delete(uri);
        resolve(updated);
      };
      const changed = () => {
        if (this.revision(uri) > afterRevision) finish(true);
      };
      const timer = setTimeout(() => finish(false), maxWaitTime);
      let listeners = this.listeners.get(uri);
      if (!listeners) {
        listeners = new Set();
        this.listeners.set(uri, listeners);
      }
      listeners.add(changed);
      changed();
    });
  }

  delete(uri: string): void {
    this.diagnostics.delete(uri);
    this.lastUpdate.delete(uri);
    this.versions.delete(uri);
    this.revisions.delete(uri);
    for (const listener of this.listeners.get(uri) ?? []) listener();
  }

  waitForIdle(
    uri: string,
    options: { maxWaitTime?: number; idleTime?: number; checkInterval?: number } = {}
  ): Promise<void> {
    return this.waitForAllIdle([uri], { maxWaitTime: 1000, idleTime: 100, ...options });
  }

  waitForAllIdle(
    uris: string[],
    options: { maxWaitTime?: number; idleTime?: number; checkInterval?: number } = {}
  ): Promise<void> {
    const selected = [...new Set(uris)];
    if (selected.length === 0) return Promise.resolve();
    const { maxWaitTime = 15000, idleTime = 500 } = options;
    return new Promise((resolve) => {
      let idleTimer: ReturnType<typeof setTimeout> | undefined;
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        clearTimeout(idleTimer);
        for (const uri of selected) {
          const listeners = this.listeners.get(uri);
          listeners?.delete(changed);
          if (listeners?.size === 0) this.listeners.delete(uri);
        }
        resolve();
      };
      const changed = () => {
        clearTimeout(idleTimer);
        const updates = selected.map((uri) => this.lastUpdate.get(uri));
        if (updates.some((time) => time === undefined)) return;
        const remaining = Math.max(0, idleTime - (Date.now() - Math.max(...(updates as number[]))));
        idleTimer = setTimeout(finish, remaining);
      };
      const deadline = setTimeout(finish, maxWaitTime);
      for (const uri of selected) {
        let listeners = this.listeners.get(uri);
        if (!listeners) {
          listeners = new Set();
          this.listeners.set(uri, listeners);
        }
        listeners.add(changed);
      }
      changed();
    });
  }
}
