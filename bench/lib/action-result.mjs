// Comparing one recorded action-install dogfood run against another.
//
// The baseline here is doing a different job from bench/baseline.public.json.
// That one records what dep-guard FINDS, where a difference is usually a
// judgement call about precision. This one records whether an attack
// SUCCEEDED, where every difference is either a regression or a fix, and
// neither is something to notice months later. So the comparison is exact on
// every recorded field and the harness exits non-zero on any difference at
// all -- including a difference in the PRE-FIX case, which is the negative
// control: if the vulnerable action stops showing the attack, the harness has
// stopped being able to see the thing it exists to watch for, and that is a
// louder failure than a regression, not a quieter one.

import { flattenCounts } from './baseline.mjs';

function indexCases(entries) {
  const byId = new Map();
  for (const entry of entries ?? []) {
    if (typeof entry?.id === 'string') {
      byId.set(entry.id, entry);
    }
  }
  return byId;
}

export function compareRuns(run, baseline) {
  if (baseline === null || typeof baseline !== 'object' || !Array.isArray(baseline.cases)) {
    throw new Error('baseline is missing or is not a recorded action-install run');
  }

  const drift = [];
  const before = indexCases(baseline.cases);
  const after = indexCases(run.cases);

  for (const [id, baseCase] of before) {
    const runCase = after.get(id);
    if (runCase === undefined) {
      drift.push({ id, kind: 'not-run' });
      continue;
    }
    const baseFields = flattenCounts(baseCase.observed);
    const runFields = flattenCounts(runCase.observed);
    for (const key of new Set([...Object.keys(baseFields), ...Object.keys(runFields)])) {
      const beforeValue = baseFields[key];
      const afterValue = runFields[key];
      if (JSON.stringify(beforeValue ?? null) !== JSON.stringify(afterValue ?? null)) {
        drift.push({ id, kind: 'field', key, before: beforeValue, after: afterValue });
      }
    }
  }

  for (const id of after.keys()) {
    if (!before.has(id)) {
      drift.push({ id, kind: 'unbaselined' });
    }
  }

  return { changed: drift.length > 0, drift };
}

function render(value) {
  if (value === undefined) return '(absent)';
  if (Array.isArray(value)) return value.length === 0 ? '[]' : value.join(' ');
  return String(value);
}

export function formatRunComparison(comparison) {
  if (!comparison.changed) {
    return 'This run matches the baseline.';
  }
  const lines = [`${comparison.drift.length} difference(s) from the baseline:`];
  for (const item of comparison.drift) {
    switch (item.kind) {
      case 'field':
        lines.push(`  ${item.id}  ${item.key}: ${render(item.before)} to ${render(item.after)}`);
        break;
      case 'not-run':
        lines.push(`  ${item.id}  in the baseline but not in this run`);
        break;
      case 'unbaselined':
        lines.push(`  ${item.id}  in this run but not in the baseline`);
        break;
      default:
        lines.push(`  ${item.id}  ${item.kind}`);
    }
  }
  return lines.join('\n');
}

// One line per case, so a reader can see the shape of the result without
// opening the JSON. The two columns that matter are on the left: whether the
// hostile registry was contacted at all, and which program actually produced
// the SARIF the gate then read.
export function formatTable(cases) {
  const header = ['case', 'evil-reqs', 'evil-ran', 'planted-ran', 'scanner', 'gate'];
  const rows = cases.map((entry) => [
    entry.id,
    String(entry.observed.evilRegistry.requestCount),
    String(entry.observed.markers.hostileRegistryCopyRan),
    String(entry.observed.markers.plantedCopyRan),
    String(entry.observed.scannerThatRan),
    entry.observed.gate.exitCode === '' ? '(none)' : String(entry.observed.gate.exitCode),
  ]);
  const widths = header.map((label, column) =>
    Math.max(label.length, ...rows.map((row) => row[column].length))
  );
  const line = (cells) =>
    cells
      .map((cell, column) => cell.padEnd(widths[column]))
      .join('  ')
      .trimEnd();
  return [line(header), ...rows.map(line)].join('\n');
}
