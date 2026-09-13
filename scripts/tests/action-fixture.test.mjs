// The pure and near-pure pieces of bench/lib/action-fixture.mjs: the PATH
// arithmetic the harness runs before it trusts a result (resolveOnPath,
// stepPath, buildToolBin) and the checkout fixture itself (buildCheckout).
//
// NO REAL NPM, NO NETWORK. packRealPackages and buildHostilePackage both
// shell out to `pnpm pack` / `npm pack`, which is real package tooling this
// suite has no business exercising per test run; they are covered by the
// harness itself (bench/action-install.mjs) against the fixture's baseline.
// git is exercised here (buildCheckout), which is local and offline, same as
// every other test in this repository that touches a lockfile fixture.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import {
  SYSTEM_PATH_DIRS,
  buildCheckout,
  buildRunnerHome,
  buildToolBin,
  resolveOnPath,
  stepPath,
} from '../../bench/lib/action-fixture.mjs';

let workDir;

function tmp() {
  workDir = mkdtempSync(path.join(tmpdir(), 'action-fixture-test-'));
  return workDir;
}

afterEach(() => {
  if (workDir) {
    rmSync(workDir, { recursive: true, force: true });
    workDir = undefined;
  }
});

describe('resolveOnPath', () => {
  it('finds the first executable file with the given name, in search-path order', () => {
    const dir = tmp();
    const first = path.join(dir, 'first');
    const second = path.join(dir, 'second');
    mkdirSync(first);
    mkdirSync(second);
    // Both directories carry a "tool"; the search order, not alphabetical
    // order, is what has to decide which one wins.
    for (const at of [first, second]) {
      writeFileSync(path.join(at, 'tool'), '#!/bin/sh\n');
      chmodSync(path.join(at, 'tool'), 0o755);
    }
    expect(resolveOnPath('tool', [second, first].join(path.delimiter))).toBe(path.join(second, 'tool'));
  });

  it('skips a file that exists but is not executable', () => {
    const dir = tmp();
    writeFileSync(path.join(dir, 'tool'), '#!/bin/sh\n');
    expect(resolveOnPath('tool', dir)).toBeNull();
  });

  it('skips a directory that happens to share the name', () => {
    const dir = tmp();
    mkdirSync(path.join(dir, 'tool'));
    expect(resolveOnPath('tool', dir)).toBeNull();
  });

  it('returns null when nothing on the path answers to the name', () => {
    const dir = tmp();
    expect(resolveOnPath('nothing-here', dir)).toBeNull();
  });
});

describe('stepPath', () => {
  it('orders the checkout bin directory first, the tool bin next, then the system directories', () => {
    const result = stepPath({ workspace: '/ws', toolBinDir: '/tools' });
    expect(result.split(path.delimiter)).toEqual([
      path.join('/ws', 'node_modules', '.bin'),
      '/tools',
      ...SYSTEM_PATH_DIRS,
    ]);
  });
});

describe('buildToolBin', () => {
  it('wraps each requested tool with a script that execs its resolved absolute path', () => {
    const dir = tmp();
    const sourceDir = path.join(dir, 'source');
    mkdirSync(sourceDir);
    const realTool = path.join(sourceDir, 'mytool');
    writeFileSync(realTool, '#!/bin/sh\necho hi\n');
    chmodSync(realTool, 0o755);

    const outDir = path.join(dir, 'toolbin');
    const built = buildToolBin({ dir: outDir, tools: ['mytool'], sourcePath: sourceDir });

    expect(built.dir).toBe(outDir);
    expect(built.resolved.mytool).toBe(realTool);
    const wrapper = readFileSync(path.join(outDir, 'mytool'), 'utf8');
    expect(wrapper).toContain(JSON.stringify(realTool));
    expect(wrapper.startsWith('#!/bin/sh')).toBe(true);
  });

  it('refuses a tool that is not on the given search path, rather than building a broken wrapper', () => {
    const dir = tmp();
    expect(() =>
      buildToolBin({ dir: path.join(dir, 'toolbin'), tools: ['does-not-exist'], sourcePath: dir })
    ).toThrow(/does-not-exist is not on PATH/);
  });
});

describe('buildRunnerHome', () => {
  it('writes an npmrc pointing at the legitimate registry and the given prefix, with npm noise turned off', () => {
    const dir = tmp();
    const home = buildRunnerHome({
      dir: path.join(dir, 'home'),
      legitRegistryOrigin: 'http://127.0.0.1:1',
      npmPrefix: path.join(dir, 'prefix'),
    });
    const npmrc = readFileSync(path.join(home, '.npmrc'), 'utf8');
    expect(npmrc).toContain('registry=http://127.0.0.1:1/');
    expect(npmrc).toContain(`prefix=${path.join(dir, 'prefix')}`);
    expect(npmrc).toContain('audit=false');
    expect(npmrc).toContain('fund=false');
  });
});

describe('buildCheckout', () => {
  it('writes a head commit that adds the fixture dependency the corpus does not carry', () => {
    const dir = tmp();
    const checkout = buildCheckout({
      dir: path.join(dir, 'workspace'),
      version: '1.2.3',
      evilRegistryOrigin: 'http://127.0.0.1:1',
      npmrcKey: 'global',
      planted: null,
    });
    const manifest = JSON.parse(readFileSync(path.join(checkout, 'package.json'), 'utf8'));
    expect(manifest.dependencies.lodahs).toBe('1.0.0');
  });

  it('records the base commit as a remote-tracking ref, the way actions/checkout leaves it', () => {
    const dir = tmp();
    const checkout = buildCheckout({
      dir: path.join(dir, 'workspace'),
      version: '1.2.3',
      evilRegistryOrigin: 'http://127.0.0.1:1',
      npmrcKey: 'global',
      planted: null,
    });
    expect(existsSync(path.join(checkout, '.git', 'refs', 'remotes', 'origin', 'main'))).toBe(true);
  });

  it('writes a global registry pin by default, and the scoped pin only when asked', () => {
    const dir = tmp();
    const global = buildCheckout({
      dir: path.join(dir, 'global'),
      version: '1.2.3',
      evilRegistryOrigin: 'http://127.0.0.1:1',
      npmrcKey: 'global',
      planted: null,
    });
    expect(readFileSync(path.join(global, '.npmrc'), 'utf8')).toBe('registry=http://127.0.0.1:1/\n');

    const scoped = buildCheckout({
      dir: path.join(dir, 'scoped'),
      version: '1.2.3',
      evilRegistryOrigin: 'http://127.0.0.1:1',
      npmrcKey: 'scoped',
      planted: null,
    });
    expect(readFileSync(path.join(scoped, '.npmrc'), 'utf8')).toBe(
      '@vaultcompass:registry=http://127.0.0.1:1/\n'
    );
  });

  it('plants a node_modules copy that writes the given marker, only when asked', () => {
    const dir = tmp();
    const markerPath = path.join(dir, 'marker.txt');
    const planted = buildCheckout({
      dir: path.join(dir, 'planted'),
      version: '1.2.3',
      evilRegistryOrigin: 'http://127.0.0.1:1',
      npmrcKey: 'global',
      planted: { markerPath, marker: 'PLANTED-MARKER' },
    });
    const binScript = readFileSync(path.join(planted, 'node_modules', '.bin', 'dep-guard'), 'utf8');
    expect(binScript).toContain('PLANTED-MARKER');
    expect(binScript).toContain(markerPath);

    const bare = buildCheckout({
      dir: path.join(dir, 'bare'),
      version: '1.2.3',
      evilRegistryOrigin: 'http://127.0.0.1:1',
      npmrcKey: 'global',
      planted: null,
    });
    expect(existsSync(path.join(bare, 'node_modules'))).toBe(false);
  });
});
