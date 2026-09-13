// Tests for the release-kind decision: given a pushed tag and the two
// package versions, is this a package release (publish everything) or an
// action-only release (publish nothing, move the tag, cut a Release)?
//
// This logic used to be four lines of bash inside .github/workflows/
// release.yml, and it only knew one shape: the tag must read "v" + the
// package version or the run fails. v0.6.1 was an action-only release --
// action.yml, README, CHANGELOG and docs moved, the packages stayed at
// 0.6.0 -- so the tag push produced a red Release run that stopped at that
// assertion before it could cut a Release page. The rule now admits that
// second shape, and this file is where the admission is kept honest,
// because the property the old assertion bought must survive it: a
// mistyped or mis-pointed tag must never publish anything and must never
// describe an unpublished version in a Release.
//
// Everything here runs offline. The registry lookup is injected -- as a
// function at the library level, as an executable at the script level
// (DG_NPM_BIN, the same idea as the action suite's PATH stubs) -- so no
// test in this file can pass or fail because of what npmjs.com happened to
// answer.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from '@jest/globals';

import {
  EXACT_SEMVER,
  classifyRelease,
  compareExactSemver,
  parseExactSemver,
  readActionVersionDefault,
} from '../lib/release-kind.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = path.join(ROOT, 'scripts', 'classify-release-tag.mjs');

const CORE_NAME = '@vaultcompass/dep-guard-core';
const CLI_NAME = '@vaultcompass/dep-guard';

// A stand-in action.yml whose description block deliberately contains the
// string "default:" and a version-shaped number in prose. The real file's
// version input carries a long block scalar that names example versions,
// so a parser that just grepped for the first "default:" after "version:"
// would read the prose and be wrong in the direction that matters: it
// would compare the tag against a number nobody ships.
function actionYmlWith(defaultVersion) {
  return [
    'name: dep-guard',
    'inputs:',
    '  version:',
    '    description: |',
    '      The exact version to install, such as `9.9.9`. The default: below',
    '      is the scanner version this action tag shipped with.',
    '    required: false',
    `    default: ${defaultVersion}`,
    '  path:',
    '    description: Path to scan',
    '    required: false',
    '    default: .',
    'runs:',
    '  using: composite',
    '',
  ].join('\n');
}

function registryStub(publishedSpecs) {
  const published = new Set(publishedSpecs);
  const calls = [];
  const lookup = (name, version) => {
    calls.push(`${name}@${version}`);
    return published.has(`${name}@${version}`) ? version : null;
  };
  lookup.calls = calls;
  return lookup;
}

// The happy action-only case, spelled out once: packages at 0.6.0 and both
// live on the registry at exactly that version, action.yml's default at
// 0.6.0, tag v0.6.1.
function actionOnlyInputs(overrides = {}) {
  return {
    tagName: 'v0.6.1',
    refDescription: 'tag v0.6.1',
    coreName: CORE_NAME,
    coreVersion: '0.6.0',
    cliName: CLI_NAME,
    cliVersion: '0.6.0',
    actionYmlText: actionYmlWith('0.6.0'),
    publishedVersion: registryStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]),
    ...overrides,
  };
}

describe('parseExactSemver', () => {
  it('accepts an exact three-part version with no leading zeros', () => {
    expect(parseExactSemver('0.6.0')).toEqual([0, 6, 0]);
    expect(parseExactSemver('10.20.30')).toEqual([10, 20, 30]);
  });

  it('rejects prerelease and build suffixes, leading zeros, and short forms', () => {
    for (const bad of ['0.6.1-rc.1', '0.6.1+build.5', '01.2.3', '0.6.00', '0.6', 'v0.6.1', '', 'latest']) {
      expect(parseExactSemver(bad)).toBeNull();
    }
  });

  it('uses the same shape action.yml validates its version input against', () => {
    // The action refuses anything this pattern does not admit, so a tag
    // the action could not be pinned to is not a tag this repo should
    // treat as an action release.
    expect(EXACT_SEMVER.source).toBe('^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)$');
  });
});

describe('compareExactSemver', () => {
  it('orders by number, not by string', () => {
    // The string comparison bash would have done reads "0.10.0" as less
    // than "0.9.0". This is the one place that difference decides whether
    // a tag is a forward move or a mistake.
    expect(compareExactSemver([0, 10, 0], [0, 9, 0])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 6, 1], [0, 6, 0])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 6, 0], [0, 6, 1])).toBeLessThan(0);
    expect(compareExactSemver([1, 0, 0], [0, 99, 99])).toBeGreaterThan(0);
    expect(compareExactSemver([0, 6, 0], [0, 6, 0])).toBe(0);
  });
});

describe('readActionVersionDefault', () => {
  it('reads the version input default, not a version-shaped string in its prose', () => {
    expect(readActionVersionDefault(actionYmlWith('0.6.0'))).toBe('0.6.0');
  });

  it('is not confused by a later input that also has a default', () => {
    expect(readActionVersionDefault(actionYmlWith('1.2.3'))).toBe('1.2.3');
  });

  it('throws when there is no version input to read', () => {
    const yml = ['inputs:', '  path:', '    default: .', ''].join('\n');
    expect(() => readActionVersionDefault(yml)).toThrow(/version/i);
  });

  it('throws when the version input has no default', () => {
    const yml = ['inputs:', '  version:', '    required: true', '  path:', '    default: .', ''].join('\n');
    expect(() => readActionVersionDefault(yml)).toThrow(/default/i);
  });

  it('reads the real action.yml and finds an exact semver default', () => {
    // Keeps the parser honest against the file it actually has to parse.
    // Asserting the shape rather than the literal number on purpose: the
    // number moves every scanner release, and a test that has to be
    // edited on every release gets edited without being read.
    const real = readActionVersionDefault(readFileSync(path.join(ROOT, 'action.yml'), 'utf8'));
    expect(real).toMatch(EXACT_SEMVER);
  });
});

describe('classifyRelease', () => {
  it('calls a tag that equals v plus the package version a package release', () => {
    const publishedVersion = registryStub([]);
    const result = classifyRelease({
      ...actionOnlyInputs(),
      tagName: 'v0.6.0',
      refDescription: 'tag v0.6.0',
      publishedVersion,
    });

    expect(result.actionOnly).toBe(false);
    expect(result.scannerVersion).toBe('0.6.0');
    // The package path must behave exactly as it did before this feature
    // existed, which includes touching the registry not at all: a package
    // release publishes a version that is by definition NOT on the
    // registry yet.
    expect(publishedVersion.calls).toEqual([]);
  });

  it('calls a greater tag with both packages published and the action default in step an action-only release', () => {
    const inputs = actionOnlyInputs();
    const result = classifyRelease(inputs);

    expect(result.actionOnly).toBe(true);
    // The Release body names the scanner the tag installs; it is the
    // published package version, never the tag.
    expect(result.scannerVersion).toBe('0.6.0');
    expect([...inputs.publishedVersion.calls].sort()).toEqual([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`].sort());
  });

  it('fails when the tag is below the package version', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.5.9', refDescription: 'tag v0.5.9' }))
    ).toThrow(/greater/i);
  });

  it('fails when the tag is numerically below the package version but above it as a string', () => {
    // 0.9.0 sorts after 0.10.0 as text. If the comparison were textual
    // this tag would be accepted as a forward move onto an older line.
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          tagName: 'v0.9.0',
          refDescription: 'tag v0.9.0',
          coreVersion: '0.10.0',
          cliVersion: '0.10.0',
          actionYmlText: actionYmlWith('0.10.0'),
          publishedVersion: registryStub([`${CORE_NAME}@0.10.0`, `${CLI_NAME}@0.10.0`]),
        })
      )
    ).toThrow(/greater/i);
  });

  it('fails on a tag with a prerelease suffix', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.6.1-rc.1', refDescription: 'tag v0.6.1-rc.1' }))
    ).toThrow(/exact semver/i);
  });

  it('fails on a tag with a build suffix', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.6.1+build.5', refDescription: 'tag v0.6.1+build.5' }))
    ).toThrow(/exact semver/i);
  });

  it('fails on a tag with a leading-zero component', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.06.1', refDescription: 'tag v0.06.1' }))
    ).toThrow(/exact semver/i);
  });

  it('fails on a tag that does not begin with v', () => {
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: '0.6.1', refDescription: 'tag 0.6.1' }))
    ).toThrow(/exact semver/i);
  });

  it('fails when core is not on the registry at the package version', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({ publishedVersion: registryStub([`${CLI_NAME}@0.6.0`]) })
      )
    ).toThrow(new RegExp(CORE_NAME.replace('/', '\\/')));
  });

  it('fails when the cli is not on the registry at the package version', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({ publishedVersion: registryStub([`${CORE_NAME}@0.6.0`]) })
      )
    ).toThrow(/registry/i);
  });

  it('fails when the registry answers with a different version than it was asked for', () => {
    const publishedVersion = () => '0.5.0';
    expect(() => classifyRelease(actionOnlyInputs({ publishedVersion }))).toThrow(/registry/i);
  });

  it("fails when action.yml's version default is not the package version", () => {
    // The tag is allowed to move without the scanner. The default is not:
    // an action-only tag ships the scanner that is already published, so a
    // moved default means the scanner changed and this is a package
    // release that forgot to bump its packages.
    expect(() =>
      classifyRelease(actionOnlyInputs({ actionYmlText: actionYmlWith('0.6.1') }))
    ).toThrow(/action\.yml/i);
  });

  it('fails when core and cli versions disagree, before anything else is considered', () => {
    const publishedVersion = registryStub([]);
    expect(() =>
      classifyRelease(actionOnlyInputs({ cliVersion: '0.5.0', publishedVersion }))
    ).toThrow(/lockstep/i);
    expect(publishedVersion.calls).toEqual([]);
  });

  it('checks lockstep and nothing else when there is no tag at all', () => {
    // workflow_dispatch: GITHUB_REF_TYPE is "branch", there is no tag to
    // classify, and the branch guard earlier in the job is what keeps the
    // run on main.
    const publishedVersion = registryStub([]);
    const result = classifyRelease({
      ...actionOnlyInputs(),
      tagName: null,
      refDescription: 'branch main (not a tag push)',
      publishedVersion,
    });
    expect(result.actionOnly).toBe(false);
    expect(publishedVersion.calls).toEqual([]);

    expect(() =>
      classifyRelease({
        ...actionOnlyInputs(),
        tagName: null,
        refDescription: 'branch main (not a tag push)',
        cliVersion: '0.5.0',
      })
    ).toThrow(/lockstep/i);
  });

  it('fails legibly when the package version itself is not exact semver and the tag differs', () => {
    expect(() =>
      classifyRelease(
        actionOnlyInputs({
          coreVersion: '0.6.0-rc.1',
          cliVersion: '0.6.0-rc.1',
          actionYmlText: actionYmlWith('0.6.0'),
        })
      )
    ).toThrow(/package version/i);
  });

  it('names the ref in every failure message', () => {
    // The whole point of failing here rather than at publish time is that
    // a human reads the message at tag time. A message that does not name
    // the tag makes them go look it up.
    expect(() =>
      classifyRelease(actionOnlyInputs({ tagName: 'v0.5.9', refDescription: 'tag v0.5.9' }))
    ).toThrow(/tag v0\.5\.9/);
  });
});

// The workflow half. The library above can be perfectly correct while
// .github/workflows/release.yml ignores its answer, and the failure that
// would produce is the expensive one: a publish on a tag that was supposed
// to publish nothing, or a Release page announcing a publish that did not
// happen. Nothing here re-tests the decision -- it tests that the decision
// is wired to the steps it is supposed to govern.
//
// Textual rather than through a YAML parser on purpose: this repository
// has no YAML dependency, and the release job's decision step runs before
// `pnpm install` precisely so it depends on nothing.
describe('.github/workflows/release.yml wiring', () => {
  // DG_RELEASE_WORKFLOW points this suite at a mutated copy, the same
  // override and the same reason as DG_ACTION_FILE in the action suites:
  // a guard nobody has watched fail is a guard nobody knows works. Used to
  // confirm that dropping the gate from "Publish to npm" turns this file
  // red, which is not something that can be tried on the real file.
  const workflow = readFileSync(
    process.env.DG_RELEASE_WORKFLOW ?? path.join(ROOT, '.github', 'workflows', 'release.yml'),
    'utf8'
  );
  const GATE = "steps.kind.outputs.action_only != 'true'";

  // The release job's steps sit at four spaces; the smoke job's at six, so
  // this reads only the first job.
  function releaseJobSteps() {
    const lines = workflow.split('\n');
    const steps = [];
    let current = null;
    for (const line of lines) {
      const nameMatch = /^ {4}- name: (.*)$/.exec(line);
      if (nameMatch !== null) {
        current = { name: nameMatch[1].trim(), if: null };
        steps.push(current);
        continue;
      }
      if (current !== null) {
        const ifMatch = /^ {6}if: (.*)$/.exec(line);
        if (ifMatch !== null) {
          current.if = ifMatch[1].trim();
        }
        if (/^ {2}\S/.test(line)) {
          current = null;
        }
      }
    }
    return steps;
  }

  // Every step that exists to protect, perform, or announce a publish.
  // Asserted as an exact set: a new step on this side of the workflow
  // without the gate fails here, and so does dropping the gate from one
  // that has it. A step that genuinely should run on both paths (tag
  // resolution, checkout) has to be left out of this list deliberately,
  // which is the decision this test exists to force someone to make.
  const GATED_STEPS = [
    'Install dependencies',
    'Build packages',
    'Typecheck',
    'Lint (public repository hygiene guard)',
    'Run tests',
    'Build the shipped corpus',
    'Check the corpus is fit to publish',
    'Check the corpus reaches the packed tarball',
    'Install the packed tarballs and run the shipped binary',
    'Upgrade npm for OIDC trusted publishing',
    'Publish to npm',
    'Create GitHub Release',
  ];

  it('gates exactly the publish-side steps on the decision step output', () => {
    const gated = releaseJobSteps()
      .filter((step) => step.if === GATE)
      .map((step) => step.name);
    expect(gated.sort()).toEqual([...GATED_STEPS].sort());
  });

  it('leaves tag resolution ungated, since both kinds of release cut a Release', () => {
    const resolve = releaseJobSteps().find((step) => step.name === 'Resolve release tag');
    expect(resolve).toBeDefined();
    expect(resolve.if).toBeNull();
  });

  it('claims a publish only on the path that performs one', () => {
    // "Published ... to npm" must live in exactly one Release body, and
    // that body's step must carry the same gate as the publish step. An
    // action-only release that announced a publish would be sending
    // people to look for a version that does not exist.
    const publishClaims = workflow.match(/Published `@vaultcompass\/dep-guard`/g) ?? [];
    expect(publishClaims).toHaveLength(1);

    const release = releaseJobSteps().find((step) => step.name === 'Create GitHub Release');
    expect(release.if).toBe(GATE);

    const actionOnlyRelease = releaseJobSteps().find(
      (step) => step.name === 'Create GitHub Release (action-only)'
    );
    expect(actionOnlyRelease.if).toBe("steps.kind.outputs.action_only == 'true'");
    expect(workflow).toContain('Nothing was published to npm by this release.');
    expect(workflow).toContain('CHANGELOG.md');
  });

  it('skips the published-CLI smoke job when nothing was published', () => {
    expect(workflow).toContain("if: needs.release.outputs.action_only != 'true'");
    expect(workflow).toContain('action_only: ${{ steps.kind.outputs.action_only }}');
  });

  it('calls the decision script from a step with the id the conditions read', () => {
    expect(workflow).toMatch(/^ {4}- name: Decide the release kind[^\n]*\n {6}id: kind$/m);
    expect(workflow).toContain('node scripts/classify-release-tag.mjs');
    // The ancestry check stays in bash, next to the git fetches it needs,
    // and stays outside the package-release branch: it applies to both
    // kinds of tag.
    expect(workflow).toContain('git merge-base --is-ancestor');
  });
});

// The script half: argument handling, the real spawn of an npm-shaped
// executable, and the GITHUB_OUTPUT contract the workflow's later steps
// read. DG_NPM_BIN points at a stub here, so this never reaches the
// network -- and the stub records what it was asked, so "the package path
// does not consult the registry" is proven against the real spawn path and
// not only against the injected function above.
describe('classify-release-tag.mjs', () => {
  function makeNpmStub(publishedSpecs) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-npm-stub-'));
    const bin = path.join(dir, 'npm-stub.mjs');
    const log = path.join(dir, 'calls.log');
    const source = [
      '#!/usr/bin/env node',
      "import { appendFileSync } from 'node:fs';",
      `const published = ${JSON.stringify(publishedSpecs)};`,
      `appendFileSync(${JSON.stringify(log)}, process.argv.slice(2).join(' ') + '\\n');`,
      "const spec = process.argv[3] ?? '';",
      'if (!published.includes(spec)) {',
      "  process.stderr.write('npm error code E404\\n');",
      '  process.exit(1);',
      '}',
      "process.stdout.write(spec.slice(spec.lastIndexOf('@') + 1) + '\\n');",
      '',
    ].join('\n');
    writeFileSync(bin, source);
    chmodSync(bin, 0o755);
    writeFileSync(log, '');
    return { bin, log, dir };
  }

  function run(args, env) {
    const outFile = path.join(mkdtempSync(path.join(tmpdir(), 'dg-gh-out-')), 'output.txt');
    // Actions creates this file before the step runs and the script only
    // ever appends, so the harness creates it too. Reading it back has to
    // work on the failure paths as well: "the run failed AND wrote no
    // action_only=true" is one of the things being asserted.
    writeFileSync(outFile, '');
    const result = spawnSync(process.execPath, [SCRIPT, ...args], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, GITHUB_OUTPUT: outFile, ...env },
    });
    return { ...result, outputs: readFileSync(outFile, 'utf8') };
  }

  const baseArgs = (tag) => [
    ...(tag === null ? [] : ['--tag', tag]),
    '--core-name',
    CORE_NAME,
    '--core-version',
    '0.6.0',
    '--cli-name',
    CLI_NAME,
    '--cli-version',
    '0.6.0',
  ];

  function withActionYml(defaultVersion) {
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-action-yml-'));
    const file = path.join(dir, 'action.yml');
    writeFileSync(file, actionYmlWith(defaultVersion));
    return file;
  }

  it('reports action_only=true and the scanner version for a valid action-only tag', () => {
    const stub = makeNpmStub([`${CORE_NAME}@0.6.0`, `${CLI_NAME}@0.6.0`]);
    const result = run([...baseArgs('v0.6.1'), '--action-yml', withActionYml('0.6.0')], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain('action_only=true');
    expect(result.outputs).toContain('scanner_version=0.6.0');
    expect(readFileSync(stub.log, 'utf8')).toContain(`view ${CORE_NAME}@0.6.0 version`);
  });

  it('reports action_only=false for a package-release tag and never runs npm', () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs('v0.6.0'), '--action-yml', withActionYml('0.6.0')], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(0);
    expect(result.outputs).toContain('action_only=false');
    expect(readFileSync(stub.log, 'utf8')).toBe('');
  });

  it('exits 1 with a workflow error annotation when the packages are not published', () => {
    const stub = makeNpmStub([]);
    const result = run([...baseArgs('v0.6.1'), '--action-yml', withActionYml('0.6.0')], {
      DG_NPM_BIN: stub.bin,
    });

    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('::error::');
    expect(result.stdout + result.stderr).toContain(CORE_NAME);
    expect(result.outputs).not.toContain('action_only=true');
  });

  it('exits 1 when a required argument is missing', () => {
    const result = run(['--tag', 'v0.6.1'], {});
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(/--core-name/);
  });

  it('treats an npm lookup that fails for any reason as not published', () => {
    // Fail closed. A registry outage blocks an action-only tag; it must
    // never be read as "published, go ahead".
    const dir = mkdtempSync(path.join(tmpdir(), 'dg-npm-broken-'));
    const bin = path.join(dir, 'npm-broken');
    writeFileSync(bin, '#!/bin/sh\nexit 7\n');
    chmodSync(bin, 0o755);

    const result = run([...baseArgs('v0.6.1'), '--action-yml', withActionYml('0.6.0')], {
      DG_NPM_BIN: bin,
    });
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toContain('::error::');
  });
});
