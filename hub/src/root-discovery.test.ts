import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectProjectRoot } from './root-discovery.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'cclsp-root-discovery-'));
  roots.push(root);
  return root;
}

describe('cclsp Hub project-root discovery', () => {
  it('selects the nearest strong language project for a file', () => {
    const root = fixture();
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, 'package.json'), '{}');
    mkdirSync(join(root, 'packages/app/src'), { recursive: true });
    writeFileSync(join(root, 'packages/app/tsconfig.json'), '{}');
    const file = join(root, 'packages/app/src/index.ts');
    writeFileSync(file, 'export const value = 1;');
    expect(detectProjectRoot(file)).toBe(join(root, 'packages/app'));
  });

  it('chooses a nearer package boundary over an outer language config', () => {
    const root = fixture();
    writeFileSync(join(root, 'tsconfig.json'), '{}');
    mkdirSync(join(root, 'packages/app/src'), { recursive: true });
    writeFileSync(join(root, 'packages/app/package.json'), '{}');
    const file = join(root, 'packages/app/src/index.ts');
    writeFileSync(file, 'export const value = 1;');
    expect(detectProjectRoot(file)).toBe(join(root, 'packages/app'));
  });

  it('falls back to package.json and then the repository boundary', () => {
    const root = fixture();
    mkdirSync(join(root, '.git'));
    mkdirSync(join(root, 'src'));
    const file = join(root, 'src/index.js');
    writeFileSync(file, 'export default 1;');
    expect(detectProjectRoot(file)).toBe(root);
    mkdirSync(join(root, 'nested/lib'), { recursive: true });
    writeFileSync(join(root, 'nested/package.json'), '{}');
    const nested = join(root, 'nested/lib/a.js');
    writeFileSync(nested, 'export default 2;');
    expect(detectProjectRoot(nested)).toBe(join(root, 'nested'));
  });

  it('returns undefined when no project or repository owns the target', () => {
    const root = fixture();
    mkdirSync(join(root, 'plain'));
    const file = join(root, 'plain/a.txt');
    writeFileSync(file, 'x');
    expect(detectProjectRoot(file)).toBeUndefined();
  });
});
