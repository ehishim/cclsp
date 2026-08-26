// Language-project discovery used only after no warm Hub root covers a target.

import { existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const PROJECT_MARKERS = [
  'tsconfig.json', 'jsconfig.json', 'package.json', 'composer.json', 'go.mod',
  'pyproject.toml', 'setup.py', 'Cargo.toml', 'pom.xml', 'build.gradle',
  'build.gradle.kts',
];

export function projectSearchDirectory(target: string): string {
  const absolute = resolve(target);
  try {
    return statSync(absolute).isDirectory() ? absolute : dirname(absolute);
  } catch {
    return dirname(absolute);
  }
}

export function detectProjectRoot(target: string): string | undefined {
  let dir = projectSearchDirectory(target);
  for (let depth = 0; depth < 64; depth += 1) {
    if (PROJECT_MARKERS.some((marker) => existsSync(join(dir, marker)))) return dir;
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}
