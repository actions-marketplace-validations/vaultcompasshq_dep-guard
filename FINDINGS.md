# FINDINGS

This is a durable, append-by-PR record of what dep-guard actually did when
run against real dependency changes: this repo's own dependency diffs, other
Vault & Compass repos, or public package manifests and lockfiles. A gate
result that only lives in a terminal scroll or a closed pull request
evaporates; this file is the place it lands instead, so false-positive and
false-negative classes accumulate across runs instead of being rediscovered
by the next person who hits them.

A run that found nothing still gets a row. "It caught nothing" is itself a
datum: it is the only way to tell whether the scanner is blind on that input
or the base rate of risky dependencies in it is genuinely low. Log the clean
run, not just the interesting one.

## Format

One row per run. Append new rows at the bottom, in chronological order. Do
not edit or delete existing rows; if a verdict turns out to be wrong on
later review, append a new row that corrects it and say which row it
corrects.

Verdict is one of: true positive, false positive, true negative, false
negative, could-not-run.

| Date | What was scanned (repo/artifact + version) | What the gate said | Verdict | Follow-up |
|---|---|---|---|---|
| 2026-01-01 (EXAMPLE) | example-app (git SHA abc1234) + dep-guard 0.6.0, dep-guard scan | 1 finding: high, typosquat expres against express | true positive | none |
| 2026-08-17 | Nine well-maintained public repositories, scanned for typosquat resemblance signals outside the curated confusion-pair list: separator swaps, scope flattening, repeated or transposed characters, keyboard adjacency, and edit distance | 3 findings across the nine repos, all at the pre-change default severity (blocking) | false positive (3 of 3; zero true positives) | Fixed in the same change: these resemblance signals were demoted to low severity by default, out of the default --fail-on gate, while the curated confusion-pair list stays at its original threshold. See README.md, "What it checks", and commit de277ba ("Split typosquat severity by confidence, demote type-only version hygiene", #5). |

## How to add an entry

Open a pull request that appends one row to the table above. Any seat may
open it, human or agent. Keep the table chronological. A clean run (true
negative) and a run the scanner could not complete (could-not-run) are both
worth recording, not just the runs that found something.
