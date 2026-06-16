#!/usr/bin/env node
// Install (or remove) a `cclsp-hub` wrapper on PATH that points at this package's
// built entry. Target dir: $CCLSP_HUB_BIN_DIR, else ~/.local/bin.
//   node scripts/install.mjs            # install
//   node scripts/install.mjs --uninstall

import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'dist', 'index.js');
const binDir = process.env.CCLSP_HUB_BIN_DIR || join(homedir(), '.local', 'bin');
const target = join(binDir, 'cclsp-hub');

if (process.argv.includes('--uninstall')) {
  if (existsSync(target)) {
    rmSync(target);
    console.log(`removed: ${target}`);
  } else {
    console.log(`nothing to remove at ${target}`);
  }
  process.exit(0);
}

if (!existsSync(entry)) {
  console.error(`build output missing: ${entry}\n  run: bun run build`);
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
writeFileSync(target, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(entry)} "$@"\n`);
chmodSync(target, 0o755);

console.log(`installed: ${target}`);
console.log(`  -> ${process.execPath} ${entry}`);
if (!(process.env.PATH || '').split(':').includes(binDir)) {
  console.log(`note: ${binDir} is not on PATH — add it to run 'cclsp-hub' directly.`);
}
