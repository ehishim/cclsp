import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const fixtures: string[] = [];

afterEach(() => {
  for (const fixture of fixtures.splice(0)) {
    rmSync(fixture, { recursive: true, force: true });
  }
});

function createFixture(): {
  root: string;
  installer: string;
  coreEntry: string;
  hubEntry: string;
  binDir: string;
} {
  const root = join(tmpdir(), `cclsp hub install ${crypto.randomUUID()}`);
  fixtures.push(root);
  const installer = join(root, 'hub', 'scripts', 'install.mjs');
  const coreEntry = join(root, 'dist', 'index.js');
  const hubEntry = join(root, 'hub', 'dist', 'index.js');
  const binDir = join(root, 'local bin');
  mkdirSync(resolve(installer, '..'), { recursive: true });
  mkdirSync(resolve(coreEntry, '..'), { recursive: true });
  mkdirSync(resolve(hubEntry, '..'), { recursive: true });
  copyFileSync(resolve(import.meta.dir, 'install.mjs'), installer);
  writeFileSync(coreEntry, 'core');
  writeFileSync(hubEntry, 'hub');
  return { root, installer, coreEntry, hubEntry, binDir };
}

describe('cclsp-hub installer', () => {
  test('pins the sibling core build while preserving runtime overrides', () => {
    const { root, installer, coreEntry, hubEntry, binDir } = createFixture();
    const installed = spawnSync('node', [installer], {
      encoding: 'utf8',
      env: { ...process.env, CCLSP_HUB_BIN_DIR: binDir },
    });
    expect(installed.status).toBe(0);

    const wrapper = join(binDir, 'cclsp-hub');
    expect(statSync(wrapper).mode & 0o111).not.toBe(0);
    expect(readFileSync(wrapper, 'utf8')).toContain('export CCLSP_HUB_ENTRY');

    const fakeRuntime = join(root, 'fake runtime');
    writeFileSync(fakeRuntime, '#!/bin/sh\nprintf "%s\\n" "$CCLSP_HUB_ENTRY|$1|$2"\n');
    chmodSync(fakeRuntime, 0o755);

    const defaultResult = spawnSync(wrapper, ['probe'], {
      encoding: 'utf8',
      env: { ...process.env, CCLSP_HUB_RUNTIME: fakeRuntime },
    });
    expect(defaultResult.status).toBe(0);
    expect(defaultResult.stdout.trim()).toBe(`${coreEntry}|${hubEntry}|probe`);

    const explicitCore = join(root, 'explicit core.js');
    const overrideResult = spawnSync(wrapper, ['probe'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        CCLSP_HUB_RUNTIME: fakeRuntime,
        CCLSP_HUB_ENTRY: explicitCore,
      },
    });
    expect(overrideResult.status).toBe(0);
    expect(overrideResult.stdout.trim()).toBe(`${explicitCore}|${hubEntry}|probe`);
  });

  for (const missingBuild of ['core', 'hub'] as const) {
    test(`refuses installation when the ${missingBuild} build is missing`, () => {
      const { installer, coreEntry, hubEntry, binDir } = createFixture();
      rmSync(missingBuild === 'core' ? coreEntry : hubEntry);
      const result = spawnSync('node', [installer], {
        encoding: 'utf8',
        env: { ...process.env, CCLSP_HUB_BIN_DIR: binDir },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('build output missing');
      expect(result.stderr).toContain('run: bun run setup');
      expect(existsSync(join(binDir, 'cclsp-hub'))).toBe(false);
    });
  }
});
