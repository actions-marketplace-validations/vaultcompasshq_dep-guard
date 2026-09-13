#!/usr/bin/env node
// Release gate: decides whether a tag push is a package release or an
// action-only release, and refuses a tag that is neither. The rules, and
// why each one exists, live in scripts/lib/release-kind.mjs; this file is
// the wiring -- arguments in, an npm lookup, a GITHUB_OUTPUT line out.
//
// Runs in .github/workflows/release.yml BEFORE pnpm install, on purpose:
// every mistake it catches is a human mistake made at tag time, none of
// it depends on anything the build produces, and catching it after the
// corpus walk costs fifteen minutes and several hundred registry
// requests. Node builtins only, for the same reason.
//
// Usage:
//   node scripts/classify-release-tag.mjs \
//     [--tag v0.6.1] \
//     --core-name @vaultcompass/dep-guard-core --core-version 0.6.0 \
//     --cli-name @vaultcompass/dep-guard --cli-version 0.6.0 \
//     [--action-yml action.yml] [--changelog CHANGELOG.md]
//
// Omit --tag for a workflow_dispatch run, which has no tag: the lockstep
// check still runs and the answer is always a package release.
//
// Outputs, appended to $GITHUB_OUTPUT when it is set:
//   action_only=true|false
//   scanner_version=<the version the packages carry>
//
// DG_NPM_BIN overrides the npm executable, which is how the tests point
// the registry lookup at a stub and stay offline -- the same idea as the
// action suite's PATH stubs.

import { spawnSync } from 'node:child_process';
import { appendFileSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { classifyRelease } from './lib/release-kind.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const REGISTRY = 'https://registry.npmjs.org';

const FLAGS = [
  '--tag',
  '--core-name',
  '--core-version',
  '--cli-name',
  '--cli-version',
  '--action-yml',
  '--changelog',
];
const REQUIRED = ['--core-name', '--core-version', '--cli-name', '--cli-version'];

function parseArgs(argv) {
  const values = new Map();
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    if (!FLAGS.includes(flag)) {
      throw new Error(`unrecognised argument "${flag}". Expected one of ${FLAGS.join(', ')}.`);
    }
    const value = argv[i + 1];
    if (value === undefined) {
      throw new Error(`${flag} needs a value.`);
    }
    values.set(flag, value);
    i += 1;
  }
  const missing = REQUIRED.filter((flag) => !values.has(flag));
  if (missing.length > 0) {
    throw new Error(`missing required argument(s): ${missing.join(', ')}.`);
  }
  return values;
}

// Returns the version the registry reports for name@version, or null. Any
// non-zero exit, spawn error, or unparseable answer reads as null, which
// the caller treats as "not published" and fails on. That direction is
// deliberate: a registry outage blocks an action-only tag, which is a
// delayed release; the other direction would let a tag claim a version
// nobody can install, which is a wrong Release page that cannot be
// un-published.
//
// Deliberately NOT run from the repository root, and deliberately passing
// --registry: this lookup is the one thing standing between a tag and a
// Release page claiming a published version, and npm reads .npmrc from
// its working directory upward. A checked-in or generated .npmrc could
// therefore point "is this published?" at some other registry -- one where
// the answer is yes -- and the question this asks is specifically about
// the public npm registry, not about whatever registry the tree prefers.
// RUNNER_TEMP on a GitHub runner, the OS temp dir otherwise; either way a
// directory this repository does not control the contents of.
function makeNpmLookup(npmBin) {
  const cwd = process.env.RUNNER_TEMP || tmpdir();
  return (name, version) => {
    const result = spawnSync(npmBin, ['view', `${name}@${version}`, 'version', `--registry=${REGISTRY}`], {
      encoding: 'utf8',
      cwd,
    });
    if (result.error || result.status !== 0) {
      return null;
    }
    const answer = String(result.stdout ?? '').trim();
    return answer === '' ? null : answer;
  };
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`::error::classify-release-tag: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const tagName = args.get('--tag') ?? null;
  const actionYmlPath = path.resolve(args.get('--action-yml') ?? path.join(ROOT, 'action.yml'));

  // An unreadable action.yml is fatal on BOTH paths, not only the
  // action-only one: the repository root's action is one of the two things
  // this workflow releases, and both paths now check its version default
  // (see assertPackageReleaseDefault in the library). Reported here as a
  // file problem rather than surfacing halfway through the decision.
  let actionYmlText;
  try {
    actionYmlText = readFileSync(actionYmlPath, 'utf8');
  } catch (err) {
    process.stderr.write(`::error::classify-release-tag: could not read ${actionYmlPath}: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  // CHANGELOG.md, by contrast, is only consulted on the action-only path,
  // so a failure to read it is passed along as null rather than made fatal
  // here. The library turns that null into a refusal on the path that
  // needs it, and a package release is not blocked by a file it never
  // asks about.
  const changelogPath = path.resolve(args.get('--changelog') ?? path.join(ROOT, 'CHANGELOG.md'));
  let changelogText = null;
  try {
    changelogText = readFileSync(changelogPath, 'utf8');
  } catch {
    changelogText = null;
  }

  const refDescription = tagName === null ? 'not a tag push' : `tag ${tagName}`;

  let decision;
  try {
    decision = classifyRelease({
      tagName,
      refDescription,
      coreName: args.get('--core-name'),
      coreVersion: args.get('--core-version'),
      cliName: args.get('--cli-name'),
      cliVersion: args.get('--cli-version'),
      actionYmlText,
      changelogText,
      publishedVersion: makeNpmLookup(process.env.DG_NPM_BIN ?? 'npm'),
    });
  } catch (err) {
    process.stderr.write(`::error::${err.message}\n`);
    process.exitCode = 1;
    return;
  }

  const outputFile = process.env.GITHUB_OUTPUT;
  if (outputFile) {
    appendFileSync(
      outputFile,
      `action_only=${decision.actionOnly ? 'true' : 'false'}\nscanner_version=${decision.scannerVersion}\n`
    );
  }

  if (decision.actionOnly) {
    console.log(
      `classify-release-tag: ${tagName} is an ACTION-ONLY release. The packages stay at ${decision.scannerVersion}, which is already on the registry; nothing will be published.`
    );
  } else {
    console.log(
      `classify-release-tag: ${refDescription} is a PACKAGE release at version ${decision.scannerVersion}.`
    );
  }
}

// realpath both sides before comparing, and fail closed on an unexpected
// error: the same reasoning as scripts/check-shippable-corpus.mjs. On
// macOS the temp dir resolves through a symlink, so a naive comparison can
// silently skip main() -- and skipping main() here means the process exits
// 0 with no decision made, which the workflow would read as "checks
// passed". Returning true on error surfaces the problem instead.
function isMainModule() {
  if (process.argv[1] === undefined) {
    return false;
  }
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return true;
  }
}

if (isMainModule()) {
  main();
}
