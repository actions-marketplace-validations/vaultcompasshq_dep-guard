// Direct tests for the pieces of scripts/lib/action-steps.mjs that
// scripts/tests/action-run-script.test.mjs only ever exercises indirectly, by
// reading the real action.yml through them. That is the right test for
// whether the real file parses; it is the wrong test for the parser's own
// edge cases, several of which were found by review feeding it legal YAML
// the real file does not currently use (see the comments on normaliseScalar
// itself). Testing those directly here means they stay covered even if the
// real file never happens to exercise them.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from '@jest/globals';

import { loadAction, normaliseScalar } from '../lib/action-steps.mjs';

describe('normaliseScalar', () => {
  it('strips a trailing comment from an unquoted scalar', () => {
    expect(normaliseScalar('some-value # a trailing comment')).toBe('some-value');
  });

  it('treats a hash with no preceding whitespace as part of the value, not a comment', () => {
    expect(normaliseScalar('a#b')).toBe('a#b');
  });

  it('returns a plain unquoted value trimmed and otherwise unchanged', () => {
    expect(normaliseScalar('  plain-value  ')).toBe('plain-value');
  });

  it('strips the surrounding quotes from a quoted scalar, keeping an inner hash literal', () => {
    expect(normaliseScalar('"a value # not a comment"')).toBe('a value # not a comment');
    expect(normaliseScalar("'a value # not a comment'")).toBe('a value # not a comment');
  });

  it('strips a trailing comment that follows a quoted scalar\'s closing quote', () => {
    // The third case a review found: the first two rules together. Checking
    // for quotes and returning early left this one's quotes in place, because
    // the comment had not been stripped yet when the quote check ran.
    expect(normaliseScalar('"quoted value" # trailing comment')).toBe('quoted value');
    expect(normaliseScalar("'quoted value' # trailing comment")).toBe('quoted value');
  });
});

// A minimal action.yml, just enough shape for loadAction to find a step, its
// run: block, and its working-directory (or the lack of one).
function writeFixtureAction(dir) {
  const file = path.join(dir, 'action.yml');
  writeFileSync(
    file,
    [
      'name: fixture',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - name: With Working Dir',
      '      shell: bash',
      '      working-directory: /somewhere/else',
      '      run: |',
      '        echo one',
      '        echo two',
      '    - name: Without Working Dir',
      '      shell: bash',
      '      run: |',
      '        echo bare',
    ].join('\n')
  );
  return file;
}

describe('extractRunScript', () => {
  let dir;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('reads a block scalar body, dedented, stopping before the next step', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'action-steps-test-'));
    const action = loadAction(writeFixtureAction(dir));
    expect(action.extractRunScript('With Working Dir')).toBe('echo one\necho two');
    expect(action.extractRunScript('Without Working Dir')).toBe('echo bare');
  });
});

describe('cwdForStep', () => {
  let dir;

  afterEach(() => {
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    }
  });

  it('evaluates a declared working-directory', () => {
    dir = mkdtempSync(path.join(tmpdir(), 'action-steps-test-'));
    const action = loadAction(writeFixtureAction(dir));
    expect(action.cwdForStep('With Working Dir', { workspace: '/ws' })).toBe('/somewhere/else');
  });

  it('defaults to the workspace -- the UNSAFE default -- when no working-directory is declared', () => {
    // The default has to be the unsafe one on purpose: a caller that defaulted
    // somewhere safe would report a step as isolated that is not. This is
    // the one behaviour in this file that is worth pinning by its absence
    // rather than only by a positive case, because getting the default
    // backwards is silent -- everything else still runs, it just runs from
    // the wrong place.
    dir = mkdtempSync(path.join(tmpdir(), 'action-steps-test-'));
    const action = loadAction(writeFixtureAction(dir));
    expect(action.cwdForStep('Without Working Dir', { workspace: '/ws' })).toBe('/ws');
  });
});
