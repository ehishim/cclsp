#!/usr/bin/env node
// Install (or remove) a `cclsp-hub` wrapper on PATH that pins the matching hub
// and core builds. Target dir: $CCLSP_HUB_BIN_DIR, else ~/.local/bin.
//   node scripts/install.mjs            # install
//   node scripts/install.mjs --uninstall

import { execSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const entry = resolve(here, '..', 'dist', 'index.js');
const coreEntry = resolve(here, '..', '..', 'dist', 'index.js');
const binDir = process.env.CCLSP_HUB_BIN_DIR || join(homedir(), '.local', 'bin');
const target = join(binDir, 'cclsp-hub');

// Pick the runtime the wrapper launches the daemon+CLI with. Prefer an explicit
// override, else Bun if it's on PATH (faster startup, and children inherit it),
// else the Node that ran this installer. The wrapper still honors a runtime
// CCLSP_HUB_RUNTIME override so users can switch without reinstalling.
function resolveRuntime() {
  if (process.env.CCLSP_HUB_RUNTIME) return process.env.CCLSP_HUB_RUNTIME;
  try {
    const bunPath = execSync('command -v bun', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (bunPath) return bunPath;
  } catch {
    // bun not found — fall through to node
  }
  return process.execPath;
}
const runtime = resolveRuntime();

function shellQuote(value) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

if (process.argv.includes('--uninstall')) {
  if (existsSync(target)) {
    rmSync(target);
    console.log(`removed: ${target}`);
  } else {
    console.log(`nothing to remove at ${target}`);
  }
  process.exit(0);
}

if (!existsSync(entry) || !existsSync(coreEntry)) {
  console.error(
    `build output missing:\n  hub: ${entry}\n  core: ${coreEntry}\n  run: bun run setup`
  );
  process.exit(1);
}

mkdirSync(binDir, { recursive: true });
const wrapper = [
  '#!/bin/sh',
  'RUNTIME="${CCLSP_HUB_RUNTIME:-}"',
  `[ -n "$RUNTIME" ] || RUNTIME=${shellQuote(runtime)}`,
  'CCLSP_HUB_ENTRY="${CCLSP_HUB_ENTRY:-}"',
  `[ -n "$CCLSP_HUB_ENTRY" ] || CCLSP_HUB_ENTRY=${shellQuote(coreEntry)}`,
  'export CCLSP_HUB_ENTRY',
  `exec "$RUNTIME" ${shellQuote(entry)} "$@"`,
  '',
].join('\n');
writeFileSync(target, wrapper);
chmodSync(target, 0o755);

console.log(`installed: ${target}`);
console.log(`  -> ${runtime} ${entry}`);
if (!(process.env.PATH || '').split(':').includes(binDir)) {
  console.log(`note: ${binDir} is not on PATH — add it to run 'cclsp-hub' directly.`);
}
