// Drift check for the load-bearing hardening in action.yml.
//
// The install suite runs the step and checks what npm was asked. That can
// stay green while the source of the step drifts: a second, weaker copy of
// the version shape, a floor comment that no longer matches the comparison,
// or an install that dropped --ignore-scripts and grew a lookalike later.
// This file reads the workflow text and pins the lines that actually run.
// A phrase that also appears in a comment is not a pin.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const actionYml = readFileSync(path.join(ROOT, 'action.yml'), 'utf8');

// The shape the sibling scanners use. It appears three times: the input
// description, and two executable matches. The count includes the
// description on purpose. The executable form is pinned separately, so a
// comment that still contains the pattern cannot keep the check green
// after a real match is removed.
const VERSION_SHAPE = String.raw`^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$`;
const VERSION_SHAPE_OCCURRENCES = 3;
const VERSION_SHAPE_EXECUTABLE = `[[ ! "\${DG_VERSION}" =~ ${VERSION_SHAPE} ]]`;
const VERSION_SHAPE_EXECUTABLE_OCCURRENCES = 2;

describe('action.yml hardening drift check', () => {
  it('keeps the npm signature floor at 10.5.2', () => {
    expect(actionYml).toContain('npm 10.5.2 or newer');
    expect(actionYml).toContain('[ "${NPM_MAJOR}" -gt 10 ]');
    expect(actionYml).toContain('[ "${NPM_MAJOR}" -eq 10 ]');
    expect(actionYml).toContain('[ "${NPM_MINOR}" -gt 5 ]');
    expect(actionYml).toContain('[ "${NPM_MINOR}" -eq 5 ]');
    expect(actionYml).toContain('[ "${NPM_PATCH}" -ge 2 ]');
  });

  it('keeps the version shape regex, and only at its current count', () => {
    expect(actionYml.split(VERSION_SHAPE).length - 1).toBe(VERSION_SHAPE_OCCURRENCES);
    expect(actionYml.split(VERSION_SHAPE_EXECUTABLE).length - 1).toBe(
      VERSION_SHAPE_EXECUTABLE_OCCURRENCES,
    );
  });

  it('installs with --ignore-scripts', () => {
    expect(actionYml).toContain(
      'npm install -g --ignore-scripts "@vaultcompass/dep-guard@${DG_VERSION}"',
    );
  });

  it('audits signatures from the cd subshell', () => {
    expect(actionYml).toContain('( cd "${npm_config_prefix}/lib" && npm audit signatures )');
  });
});
