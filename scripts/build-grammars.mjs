#!/usr/bin/env node
// Rebuild pinned grammar assets from verified sources in an isolated copy-in/copy-out container.
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, mkdtempSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'grammars/manifest.json'), 'utf8'));
const digest = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' });
for (const [name, expected] of Object.entries(manifest.patches)) {
  if (digest(join(root, 'patches', name)) !== expected) throw new Error(`Patch digest mismatch: ${name}`);
}
const scratch = mkdtempSync(join(tmpdir(), 'cclsp-grammars-'));
const container = `cclsp-grammar-${randomUUID()}`;
let created = false;
try {
  const archive = join(scratch, 'source.tar.gz');
  run('curl', ['--fail', '--location', '--output', archive, manifest.source.url]);
  if (digest(archive) !== manifest.source.sha256) throw new Error('Source archive digest mismatch');
  run('tar', ['-xzf', archive, '-C', scratch]);
  const source = join(scratch, manifest.source.directory);
  const tools = join(scratch, 'tools');
  run('npm', ['install', '--prefix', tools, '--no-save', '--ignore-scripts', '--package-lock=false',
    `tree-sitter-cli@${manifest.cliVersion}`, `tree-sitter-javascript@${manifest.javascriptVersion}`]);
  run(process.execPath, ['install.js'], join(tools, 'node_modules/tree-sitter-cli'));
  run('ln', ['-s', join(tools, 'node_modules'), join(source, 'node_modules')]);
  for (const name of Object.keys(manifest.patches)) {
    run('patch', ['-p1', '--input', join(root, 'patches', name)], source);
  }
  const cli = join(tools, 'node_modules/.bin/tree-sitter');
  for (const language of ['typescript', 'tsx']) run(cli, ['generate'], join(source, language));
  run(cli, ['test'], source);
  run('docker', ['pull', manifest.builder]);
  const commands = ['typescript', 'tsx'].map((language) =>
    `cd /src/${language} && emcc ${manifest.emccFlags.join(' ')} -s 'EXPORTED_FUNCTIONS=["_tree_sitter_${language}"]' -I src src/parser.c src/scanner.c -o /tmp/tree-sitter-${language}.wasm`);
  run('docker', ['create', '--name', container, '--network', 'none', '--cpus', '2', '--memory', '2g',
    '--entrypoint', 'sh', manifest.builder, '-c', `set -e; ${commands.join('; ')}`]);
  created = true;
  run('docker', ['cp', `${source}/.`, `${container}:/src`]);
  run('docker', ['start', '-a', container]);
  for (const [asset, expected] of Object.entries(manifest.assets)) {
    const output = join(scratch, asset);
    run('docker', ['cp', `${container}:/tmp/${asset}`, output]);
    if (digest(output) !== expected) throw new Error(`Rebuilt asset digest mismatch: ${asset}`);
  }
  for (const asset of Object.keys(manifest.assets)) copyFileSync(join(scratch, asset), join(root, 'grammars', asset));
} finally {
  try {
    if (created) run('docker', ['rm', '-f', container]);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
