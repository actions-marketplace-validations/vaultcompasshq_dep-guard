// bench/lib/action-result.mjs compares two recorded action-install runs, and
// the comparison is meant to be exact on every field, including the
// negative control: a v0.6.0 case that stopped showing the attack has to
// drift just as loudly as a regression in the current action would.

import { describe, expect, it } from '@jest/globals';

import { compareRuns, formatRunComparison, formatTable } from '../../bench/lib/action-result.mjs';

function makeCase(id, overrides = {}) {
  return {
    id,
    action: 'current',
    scenario: 'npmrc-only',
    observed: {
      scannerThatRan: 'installed-real',
      steps: { install: { present: true, status: 0 }, run: { present: true, status: 0 } },
      markers: { hostileRegistryCopyRan: false, plantedCopyRan: false },
      evilRegistry: { requestCount: 0, paths: [] },
      legitRegistry: { contacted: true, paths: ['/pkg'] },
      installedScanner: { present: true, version: '0.6.0', dgBin: 'dep-guard-action/bin/dep-guard' },
      sarif: { kind: 'real-scanner', ruleCatalogue: true, driverVersion: '0.6.0' },
      gate: { exitCode: '1', resultsFileRecorded: true },
      ...overrides,
    },
  };
}

describe('compareRuns', () => {
  it('reports no drift when the run matches the baseline exactly', () => {
    const result = compareRuns({ cases: [makeCase('a')] }, { cases: [makeCase('a')] });
    expect(result).toEqual({ changed: false, drift: [] });
  });

  it('throws when the baseline is not a recorded run, rather than comparing against nothing', () => {
    expect(() => compareRuns({ cases: [] }, {})).toThrow(/not a recorded action-install run/);
    expect(() => compareRuns({ cases: [] }, null)).toThrow(/not a recorded action-install run/);
  });

  it('flags a case the baseline has that this run does not', () => {
    const result = compareRuns({ cases: [] }, { cases: [makeCase('a')] });
    expect(result).toEqual({ changed: true, drift: [{ id: 'a', kind: 'not-run' }] });
  });

  it('flags a case this run has that the baseline does not', () => {
    const result = compareRuns({ cases: [makeCase('a')] }, { cases: [] });
    expect(result).toEqual({ changed: true, drift: [{ id: 'a', kind: 'unbaselined' }] });
  });

  it('flags one differing field, naming it by its flattened path', () => {
    const baseline = { cases: [makeCase('a', { gate: { exitCode: '1', resultsFileRecorded: true } })] };
    const run = { cases: [makeCase('a', { gate: { exitCode: '0', resultsFileRecorded: true } })] };
    const result = compareRuns(run, baseline);
    expect(result.changed).toBe(true);
    expect(result.drift).toEqual([
      { id: 'a', kind: 'field', key: 'gate.exitCode', before: '1', after: '0' },
    ]);
  });

  it('is exact on the negative control: a v0.6.0 case that stops showing the attack drifts', () => {
    const baseline = {
      cases: [
        makeCase('v0.6.0--npmrc-only', {
          scannerThatRan: 'hostile-registry',
          gate: { exitCode: '0', resultsFileRecorded: true },
        }),
      ],
    };
    const run = {
      cases: [
        makeCase('v0.6.0--npmrc-only', {
          scannerThatRan: 'installed-real',
          gate: { exitCode: '0', resultsFileRecorded: true },
        }),
      ],
    };
    const result = compareRuns(run, baseline);
    expect(result.changed).toBe(true);
    expect(result.drift).toContainEqual({
      id: 'v0.6.0--npmrc-only',
      kind: 'field',
      key: 'scannerThatRan',
      before: 'hostile-registry',
      after: 'installed-real',
    });
  });
});

describe('formatRunComparison', () => {
  it('says the run matches when there is no drift', () => {
    expect(formatRunComparison({ changed: false, drift: [] })).toBe('This run matches the baseline.');
  });

  it('renders each kind of drift on its own line', () => {
    const comparison = {
      changed: true,
      drift: [
        { id: 'a', kind: 'field', key: 'gate.exitCode', before: '1', after: '0' },
        { id: 'b', kind: 'not-run' },
        { id: 'c', kind: 'unbaselined' },
      ],
    };
    const text = formatRunComparison(comparison);
    expect(text).toContain('3 difference(s) from the baseline:');
    expect(text).toContain('a  gate.exitCode: 1 to 0');
    expect(text).toContain('b  in the baseline but not in this run');
    expect(text).toContain('c  in this run but not in the baseline');
  });
});

describe('formatTable', () => {
  it('renders the columns that matter: whether the hostile registry was contacted and what scanned', () => {
    const table = formatTable([makeCase('current--npmrc-only')]);
    const lines = table.split('\n');
    expect(lines[0].split(/\s+/)).toEqual(['case', 'evil-reqs', 'evil-ran', 'planted-ran', 'scanner', 'gate']);
    expect(lines[1]).toContain('current--npmrc-only');
    expect(lines[1]).toContain('installed-real');
    expect(lines[1]).toContain('1');
  });

  it('prints (none) rather than an empty cell when no exit code was recorded', () => {
    const table = formatTable([makeCase('a', { gate: { exitCode: '', resultsFileRecorded: false } })]);
    expect(table).toContain('(none)');
  });
});
