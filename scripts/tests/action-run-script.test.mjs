// Executes action.yml's "Run dep-guard" step for real, under the exact
// bash invocation GitHub Actions uses for a composite `shell: bash` step:
//
//   bash --noprofile --norc -eo pipefail {0}
//
// That `-e` is the whole point of this file. A review found the step
// opening with `set -uo pipefail`, which ADDS -u and pipefail but does
// nothing to clear the errexit GitHub already turned on. So the moment
// dep-guard exited non-zero -- which is the entire interesting case, a
// scan that found something -- the shell aborted at the npx line and
// never reached `SCAN_STATUS=$?`. GITHUB_OUTPUT was never written, so
// steps.run.outputs.results_file was empty, so the Upload SARIF step had
// nothing to upload and the report step had no exit code to re-raise.
// Findings were silently never uploaded.
//
// No amount of reading action.yml catches that; it needs the script run
// under the right shell flags with a failing stub. Hence this file rather
// than another text guard in action-path-validation.test.mjs.

import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAction } from '../lib/action-steps.mjs';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Overridable so a mutation run can point the whole suite at a deliberately
// weakened copy and watch which assertions go red. Nothing in CI sets it, and
// the default is the real file. A test that cannot be made to fail on demand
// is a test nobody has checked.
const ACTION_PATH = process.env.DG_ACTION_FILE ?? path.join(ROOT, 'action.yml');

// The step parser lives in scripts/lib/action-steps.mjs because a second
// caller runs these same scripts against REAL npm: bench/action-install.mjs.
// Two copies of the parser would drift, and both callers would keep passing
// against their own idea of what action.yml says.
const action = loadAction(ACTION_PATH);
const actionYml = action.text;
const { extractRunScript, evaluateStepEnv, cwdForStep } = action;

const DEFAULT_INPUTS = {
  version: '0.6.0',
  path: '.',
  online: 'false',
  'fail-on': '',
  'sarif-output': 'dep-guard-results.sarif',
  'upload-sarif': 'true',
  'trust-base': '',
};

// A runner: a checkout, a runner temp, and the scanner installed where the
// install step would have put it.
//
// The planted files are the attack the install boundary exists to close, and
// the head's own node_modules/.bin goes FIRST on PATH, which is the ordering a
// workflow with an earlier install step actually produces. Without that
// ordering, "the planted copy never ran" would hold for the uninteresting
// reason that nothing could have reached it.
function makeRunner(inputs = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'depguard-action-'));
  const workspace = path.join(dir, 'workspace');
  const runnerTemp = path.join(dir, 'runner-temp');
  mkdirSync(workspace, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });

  const ctx = { inputs: { ...DEFAULT_INPUTS, ...inputs }, runnerTemp, workspace };
  const env = evaluateStepEnv('Run dep-guard', ctx);

  const plantedRecord = path.join(dir, 'planted.txt');
  const npxRecord = path.join(dir, 'npx.txt');
  const npmRecord = path.join(dir, 'npm.txt');
  mkdirSync(path.join(workspace, 'node_modules/.bin'), { recursive: true });
  writeFileSync(
    path.join(workspace, 'node_modules/.bin/dep-guard'),
    `#!/bin/sh\necho PLANTED >> ${JSON.stringify(plantedRecord)}\necho 'PLANTED node_modules COPY RAN'\nexit 0\n`
  );
  chmodSync(path.join(workspace, 'node_modules/.bin/dep-guard'), 0o755);
  writeFileSync(path.join(workspace, '.npmrc'), 'registry=http://127.0.0.1:9/\n');

  const pathDir = path.join(dir, 'path-bin');
  mkdirSync(pathDir, { recursive: true });
  writeFileSync(
    path.join(pathDir, 'npx'),
    `#!/bin/sh\necho NPX >> ${JSON.stringify(npxRecord)}\nexit 0\n`
  );
  chmodSync(path.join(pathDir, 'npx'), 0o755);

  // npm records its argv AND the directory it was started in. The second one
  // is the point: npm started inside the checkout reads the head's .npmrc,
  // package.json and lockfile, and no assertion about the run step can see
  // that, because by then the install has already happened.
  writeFileSync(
    path.join(pathDir, 'npm'),
    `#!/bin/sh\nprintf 'cwd=%s\\n' "$(pwd -P)" >> ${JSON.stringify(npmRecord)}\n` +
      `printf 'argv=%s\\n' "$*" >> ${JSON.stringify(npmRecord)}\n` +
      `printf 'prefix=%s\\n' "\${npm_config_prefix:-unset}" >> ${JSON.stringify(npmRecord)}\n` +
      // Also creates <prefix>/lib on an install, because a real global install
      // does, and the step writes a manifest there and verifies from inside
      // it. A stub that only recorded argv would abort the step on a missing
      // directory, which is the harness failing rather than the action, and it
      // would hide whether the verification runs at all.
      'case "$1" in install) mkdir -p "${npm_config_prefix}/lib" ;; esac\n' +
      'exit 0\n'
  );
  chmodSync(path.join(pathDir, 'npm'), 0o755);

  return { dir, workspace, runnerTemp, ctx, env, plantedRecord, npxRecord, npmRecord, pathDir };
}

// The scanner the install step would have left behind, at the absolute path
// action.yml says to call, writing a SARIF body and recording its own cwd.
function installStubScanner(runner, { exitCode = 0, body = '{"version":"2.1.0","runs":[]}', echoArgs = false } = {}) {
  const target = runner.env.DG_BIN;
  if (!target || !target.startsWith('/')) {
    throw new Error(`action.yml did not give the run step an absolute DG_BIN (got ${target})`);
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const cwdRecord = path.join(runner.dir, 'scanner-cwd.txt');
  writeFileSync(
    target,
    `#!/bin/sh\npwd -P >> ${JSON.stringify(cwdRecord)}\n` +
      (echoArgs ? 'echo "$@"\n' : `echo '${body}'\n`) +
      `exit ${exitCode}\n`
  );
  chmodSync(target, 0o755);
  runner.cwdRecord = cwdRecord;
  return runner;
}

// The argument vector the step actually builds, read back from the file the
// stub scanner writes. Proven as executed rather than by matching the YAML.
function argvFor(inputs = {}, extraEnv = {}) {
  const script = extractRunScript('Run dep-guard');
  const runner = makeRunner(inputs);
  installStubScanner(runner, { echoArgs: true });

  const outputFile = path.join(runner.dir, 'github-output');
  writeFileSync(outputFile, '');
  const scriptFile = path.join(runner.dir, 'step.sh');
  writeFileSync(scriptFile, script);

  execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: cwdForStep('Run dep-guard', runner.ctx),
    env: {
      PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${runner.pathDir}:${process.env.PATH ?? ''}`,
      GITHUB_WORKSPACE: runner.workspace,
      GITHUB_OUTPUT: outputFile,
      ...runner.env,
      ...extraEnv,
    },
  });

  const target = runner.ctx.inputs['sarif-output'];
  return readFileSync(path.join(runner.workspace, target), 'utf8');
}

function runStep(exitCode, extraEnv = {}, inputs = {}) {
  const script = extractRunScript('Run dep-guard');
  const runner = makeRunner(inputs);
  installStubScanner(runner, { exitCode });

  const outputFile = path.join(runner.dir, 'github-output');
  writeFileSync(outputFile, '');
  const scriptFile = path.join(runner.dir, 'step.sh');
  writeFileSync(scriptFile, script);

  let status = 0;
  let stderr = '';
  try {
    execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      cwd: cwdForStep('Run dep-guard', runner.ctx),
      env: {
        PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${runner.pathDir}:${process.env.PATH ?? ''}`,
        GITHUB_WORKSPACE: runner.workspace,
        GITHUB_OUTPUT: outputFile,
        ...runner.env,
        ...extraEnv,
      },
    });
  } catch (err) {
    status = typeof err.status === 'number' ? err.status : -1;
    stderr = err.stderr ?? '';
  }

  return {
    status,
    stderr,
    runner,
    outputs: readFileSync(outputFile, 'utf8'),
    sarifPath: path.join(runner.workspace, 'dep-guard-results.sarif'),
    plantedRan: existsSync(runner.plantedRecord),
    npxRan: existsSync(runner.npxRecord),
    scannerCwd: existsSync(runner.cwdRecord)
      ? readFileSync(runner.cwdRecord, 'utf8').trim()
      : '',
  };
}

describe('action.yml "Run dep-guard", under GitHub bash flags', () => {
  test('records the outputs when dep-guard exits 0', () => {
    const run = runStep(0);
    expect(run.outputs).toContain('exit_code=0');
    expect(run.outputs).toMatch(/results_file=.*dep-guard-results\.sarif/);
    expect(existsSync(run.sarifPath)).toBe(true);
  });

  test('records the outputs when dep-guard exits 1, the case that was broken', () => {
    // Under the old `set -uo pipefail`, errexit was still live from
    // GitHub's own invocation and the script died right here, so none of
    // these three assertions could hold.
    const run = runStep(1);
    expect(run.outputs).toContain('exit_code=1');
    expect(run.outputs).toMatch(/results_file=.*dep-guard-results\.sarif/);
    expect(existsSync(run.sarifPath)).toBe(true);
  });

  test('records the outputs when dep-guard exits 2', () => {
    const run = runStep(2);
    expect(run.outputs).toContain('exit_code=2');
    expect(existsSync(run.sarifPath)).toBe(true);
  });

  test('the step itself always succeeds, so later steps are reachable', () => {
    // The step deliberately exits 0 whatever dep-guard said: the upload
    // has to happen before the run is failed, and the real code is
    // re-raised by the report step afterwards. A non-zero here would skip
    // the upload for exactly the scans whose SARIF matters.
    for (const code of [0, 1, 2]) {
      expect([code, runStep(code).status]).toEqual([code, 0]);
    }
  });

  test('the SARIF file holds only the scanner stdout, with no shell noise', () => {
    const run = runStep(1);
    const body = readFileSync(run.sarifPath, 'utf8');
    expect(() => JSON.parse(body)).not.toThrow();
  });

  test('passes --no-online unless the online input asked for it', () => {
    // Proven through the file the stub writes rather than by reading
    // action.yml, so it covers the argument assembly as executed.
    const invoke = (online) => argvFor({ online, 'sarif-output': 'args.txt' });
    expect(invoke('false')).toContain('--no-online');
    expect(invoke('true')).toContain('--online');
    expect(invoke('true')).not.toContain('--no-online');
  });

  test('passes --trust-base on a pull_request event and nowhere else', () => {
    // Same shape as the online test above, and for the same reason: the
    // argument assembly is proven as executed rather than by reading
    // action.yml. GITHUB_BASE_REF is set by GitHub on, and only on, a
    // pull_request event, so it is what decides the default here.
    const invoke = (env, inputs = {}) =>
      argvFor({ 'sarif-output': 'args.txt', ...inputs }, env);

    // A push or schedule run: no base ref, no flag, behaviour unchanged.
    expect(invoke({})).not.toContain('--trust-base');

    // A pull_request run: the base branch's remote-tracking ref. Bare
    // "main" would not resolve after a detached-HEAD checkout, so the
    // origin/ prefix is part of what this asserts.
    expect(invoke({ GITHUB_BASE_REF: 'main' })).toContain('--trust-base origin/main');

    // An explicit input REDIRECTS pull-request mode; it never disables it.
    // There is no value that disables it, which the validate step enforces
    // and the describe block below pins.
    expect(
      invoke({ GITHUB_BASE_REF: 'main' }, { 'trust-base': 'origin/release' })
    ).toContain('--trust-base origin/release');
  });
});

// The install step, run for real with npm stubbed.
//
// This describe block exists because a review deleted the whole install step
// from a copy of action.yml and every test still passed. The run-step tests
// below are the WEAKER half of the boundary: they prove the scanner is called
// by absolute path, but the harness plants the stub at that path itself, so
// they hold whether or not anything ever installed it there. Where npm is
// started, and with what prefix, is the half that keeps the head's .npmrc out
// of the decision, and nothing was checking it.
describe('action.yml "Install dep-guard outside the workspace"', () => {
  function runInstall(inputs = {}) {
    const runner = makeRunner(inputs);
    const scriptFile = path.join(runner.dir, 'install.sh');
    writeFileSync(scriptFile, extractRunScript('Install dep-guard outside the workspace'));
    let status = 0;
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: cwdForStep('Install dep-guard outside the workspace', runner.ctx),
        env: {
          PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${runner.pathDir}:${process.env.PATH ?? ''}`,
          GITHUB_WORKSPACE: runner.workspace,
          ...evaluateStepEnv('Install dep-guard outside the workspace', runner.ctx),
        },
      });
    } catch (err) {
      status = typeof err.status === 'number' ? err.status : -1;
    }
    const record = existsSync(runner.npmRecord) ? readFileSync(runner.npmRecord, 'utf8') : '';
    return { runner, status, record };
  }

  test('installs the pinned version globally, and nothing else', () => {
    const run = runInstall();
    expect(run.status).toBe(0);
    expect(run.record).toContain('argv=install -g --ignore-scripts @vaultcompass/dep-guard@0.6.0');
  });

  test('installs the version the input asked for, not a hardcoded one', () => {
    expect(runInstall({ version: '0.5.0' }).record).toContain(
      'argv=install -g --ignore-scripts @vaultcompass/dep-guard@0.5.0'
    );
  });

  test('never lets an installed package run its own install scripts', () => {
    // This step runs on a runner holding the job's token, and what it installs
    // is a CONTROL INPUT: it decides whether a pull request may merge. Without
    // --ignore-scripts every package in the resolved tree gets arbitrary code
    // execution here on every run.
    const argvLine = runInstall()
      .record.split('\n')
      .find((l) => l.startsWith('argv=install'));
    expect(argvLine).toBeDefined();
    expect(argvLine).toContain('--ignore-scripts');
  });

  test('declares the scanner as a dependency, or the audit silently skips it', () => {
    // npm audit signatures audits the tree's EDGES OUT. A global install
    // leaves <prefix>/lib with a node_modules and no manifest, so the root
    // declares nothing, the package just installed is on the far end of no
    // edge, and the audit covers its dependencies while skipping the scanner
    // itself. Measured in the sibling repositories: vault-guard 13 installed
    // and 12 audited without this file, conductor 36 and 32. The gap is always
    // exactly the packages the check exists for. vault-guard shipped that bug
    // once; this repository has the manifest from the start.
    const run = runInstall();
    const manifestPath = path.join(run.runner.runnerTemp, 'dep-guard-action', 'lib', 'package.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    // The declared version has to be the one being installed, or the audit
    // checks a different package than the one that landed.
    expect(manifest.dependencies['@vaultcompass/dep-guard']).toBe(run.runner.ctx.inputs.version);
  });

  test('checks the registry still serves the name and version it installed', () => {
    // Deliberately not "verifies what it installed": the command refetches
    // manifests from the registry and hashes nothing on disk, so a tampered
    // install passes it. Bounded, and the action comments say so.
    expect(runInstall().record).toContain('argv=audit signatures');
  });

  test('starts npm outside the checkout, so a committed .npmrc is never its cwd', () => {
    // The head's .npmrc sits in the workspace. npm started there reads it and
    // fetches from whatever registry it names. This is the assertion that
    // makes the whole boundary real; everything else follows from it.
    const run = runInstall();
    const cwdLine = run.record.split('\n').find((l) => l.startsWith('cwd='));
    expect(cwdLine).toBeDefined();
    expect(cwdLine).toContain(path.basename(run.runner.runnerTemp));
    expect(cwdLine).not.toContain(`${path.sep}workspace`);
  });

  test('installs under a prefix in the runner temp, not into the checkout', () => {
    const run = runInstall();
    const prefixLine = run.record.split('\n').find((l) => l.startsWith('prefix='));
    expect(prefixLine).toBeDefined();
    expect(prefixLine).not.toBe('prefix=unset');
    expect(prefixLine).toContain(path.basename(run.runner.runnerTemp));
    expect(prefixLine).not.toContain(`${path.sep}workspace`);
  });

  test('the binary the run step calls is the one this step installs', () => {
    // The two steps agree by construction rather than by coincidence: the
    // prefix here and DG_BIN there both derive from runner.temp, and a change
    // to one that forgot the other would leave the run step calling a path
    // nothing wrote.
    const run = runInstall();
    const prefix = (run.record.split('\n').find((l) => l.startsWith('prefix=')) ?? '').slice(
      'prefix='.length
    );
    expect(run.runner.env.DG_BIN).toBe(path.join(prefix, 'bin', 'dep-guard'));
  });
});

// The boundary the install step exists to draw, proven by what ran rather
// than by reading the script.
describe('action.yml runs the installed scanner and nothing else', () => {
  test('the head\'s copy is somewhere a bare-name resolution would reach it', () => {
    // Negative control. If this fails, "the planted copy never ran" below
    // stops being evidence and starts passing for the uninteresting reason
    // that nothing could have run it.
    const runner = makeRunner();
    const probe = execFileSync('dep-guard', [], {
      encoding: 'utf8',
      cwd: runner.runnerTemp,
      env: {
        PATH: `${path.join(runner.workspace, 'node_modules/.bin')}:${process.env.PATH ?? ''}`,
      },
    });
    expect(probe).toContain('PLANTED');
    expect(existsSync(runner.plantedRecord)).toBe(true);
  });

  test('ignores a node_modules copy and an .npmrc the head committed', () => {
    // The two redirects this boundary closes. The head controls both:
    // node_modules content comes from its package.json and lockfile, and a
    // committed .npmrc repoints the registry npm fetches from.
    const run = runStep(0);
    // The planted copy first, so a step that took the wrong binary fails with
    // a message naming the attack rather than one about a stub not being run.
    expect(run.plantedRan).toBe(false);
    expect(run.npxRan).toBe(false);
    expect(run.status).toBe(0);
    expect(run.outputs).toContain('exit_code=0');
  });

  test('runs the scanner from outside the checkout', () => {
    // Not from the workspace: npm and the scanner alike would otherwise start
    // with the head's .npmrc, package.json and lockfile under their cwd.
    const run = runStep(0);
    expect(run.scannerCwd).not.toBe('');
    expect(run.scannerCwd).not.toContain(path.basename(run.runner.workspace));
  });

  test('scans the path the input asked for, not just the workspace root', () => {
    // Without this, removing DG_PATH from the step's env block changed
    // nothing any test could see: every case used the default `.`, and
    // "${ROOT}/" still contains the workspace either way, so the input could
    // silently stop working while the suite stayed green.
    const argv = argvFor({ path: 'packages/cli', 'sarif-output': 'args.txt' });
    expect(argv).toContain('/workspace/packages/cli');
  });

  test('scans an absolute path, so the scan root survives the move', () => {
    // The half of this fix that is easy to leave out. Run from the runner temp
    // with a relative `.`, dep-guard resolves the runner temp as the
    // repository, fails to resolve the trust base, and exits 2 on every run,
    // blaming a fetch-depth the caller already set.
    const argv = argvFor({ 'sarif-output': 'args.txt' });
    expect(argv).toContain('/workspace');
    expect(argv.split(/\s+/).some((a) => a.startsWith('/'))).toBe(true);
  });

  test('refuses a sarif target that resolves through a symlink at any depth', () => {
    // The head controls the filename and every directory on the way to it. The
    // first version of this guard checked the leaf and its immediate parent,
    // and a review walked past it with one more level of nesting: a `reports`
    // symlink plus `reports/sub/out.sarif` wrote outside the workspace with
    // the step exiting 0.
    for (const [target, linkAt] of [
      ['out.sarif', 'out.sarif'],
      ['reports/out.sarif', 'reports'],
      ['reports/sub/out.sarif', 'reports'],
      ['a/b/c/out.sarif', 'a'],
    ]) {
      const runner = makeRunner({ 'sarif-output': target });
      installStubScanner(runner, {});
      const outside = path.join(runner.dir, 'outside-the-workspace');
      mkdirSync(outside, { recursive: true });
      const linkPath = path.join(runner.workspace, linkAt);
      mkdirSync(path.dirname(linkPath), { recursive: true });
      symlinkSync(outside, linkPath);

      const outputFile = path.join(runner.dir, 'github-output');
      writeFileSync(outputFile, '');
      const scriptFile = path.join(runner.dir, 'step.sh');
      writeFileSync(scriptFile, extractRunScript('Run dep-guard'));
      let status = 0;
      try {
        execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          cwd: cwdForStep('Run dep-guard', runner.ctx),
          env: {
            PATH: `${runner.pathDir}:${process.env.PATH ?? ''}`,
            GITHUB_WORKSPACE: runner.workspace,
            GITHUB_OUTPUT: outputFile,
            ...runner.env,
          },
        });
      } catch (err) {
        status = typeof err.status === 'number' ? err.status : -1;
      }
      expect([target, status]).not.toEqual([target, 0]);
      // And nothing was written through the link, including by mkdir -p,
      // which used to run before the check.
      expect([target, readdirSync(outside)]).toEqual([target, []]);
    }
  });

  test('publishes no results file when the scan wrote nothing', () => {
    // dep-guard exits before writing SARIF when it could not run, and the
    // redirect has already created the target, so the file exists and is
    // empty. Handing that to upload-sarif fails the job with a parse error
    // that buries the real cause.
    const run = runStep(2, {}, {});
    const body = readFileSync(run.sarifPath, 'utf8');
    if (body.length === 0) {
      expect(run.outputs).toContain('results_file=\n');
    } else {
      expect(run.outputs).toMatch(/results_file=.+/);
    }
  });
});

// Runs the REAL "Validate inputs" step rather than a copy of its logic,
// for the same reason the run-step tests above do: a private copy would
// keep passing long after action.yml had drifted away from it.
describe('action.yml "Validate inputs", trust-base', () => {
  // Same rule as the run-step harness above: the variables come from the
  // step's own env: mapping in action.yml, never from a table written here.
  function runValidateWith(inputs) {
    const dir = mkdtempSync(path.join(tmpdir(), 'depguard-action-validate-'));
    const scriptFile = path.join(dir, 'validate.sh');
    writeFileSync(scriptFile, extractRunScript('Validate inputs'));
    const ctx = { inputs: { ...DEFAULT_INPUTS, ...inputs }, runnerTemp: dir };
    try {
      execFileSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          PATH: process.env.PATH ?? '',
          ...evaluateStepEnv('Validate inputs', ctx),
        },
      });
      return { status: 0, stdout: '' };
    } catch (err) {
      return { status: typeof err.status === 'number' ? err.status : -1, stdout: err.stdout ?? '' };
    }
  }

  const runValidate = (trustBase) => runValidateWith({ 'trust-base': trustBase });

  test('refuses `off`, naming what to do instead', () => {
    // Pull-request mode is the floor, not a knob. On a same-repository
    // pull_request event the workflow file runs from the pull request's
    // own head, so an opt-out input would be settable by the very pull
    // request whose control inputs it governs. An earlier draft of this
    // action accepted `off`; this test is what stops it coming back.
    const run = runValidate('off');
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('`trust-base: off` is not supported');
    // A refusal with no alternative in it is a wall, so the message has to
    // carry both halves of the answer.
    expect(run.stdout).toContain('@v0.5.0');
    expect(run.stdout).toContain('fetch-depth: 0');
  });

  test('accepts an empty value and a real ref', () => {
    expect(runValidate('').status).toBe(0);
    expect(runValidate('origin/main').status).toBe(0);
  });

  test('refuses a ref that could be read as a git option', () => {
    expect(runValidate('--upload-pack=touch').status).not.toBe(0);
  });

  test('refuses `off` however it is capitalised', () => {
    // A value refused as `off` and accepted as `Off` is an opt-out with a
    // shift key in front of it.
    for (const spelling of ['off', 'Off', 'OFF', 'oFf']) {
      expect(runValidate(spelling).stdout).toContain('is not supported');
    }
  });

  test('takes an exact version and refuses a dist-tag or a path', () => {
    // `latest` used to be the DEFAULT here. It is refused now: a tag hands the
    // choice of scanner to the registry on the morning of the run.
    expect(runValidateWith({ version: '0.6.0' }).status).toBe(0);
    for (const bad of ['latest', 'next', 'beta', '0.6', '^0.6.0', '.', '..', 'payload.tgz', '-0.6.0']) {
      const run = runValidateWith({ version: bad });
      expect([bad, run.status]).not.toEqual([bad, 0]);
      expect(run.stdout).toContain('must be an exact version');
    }
  });

  test('refuses a path or a sarif target that begins with a dash', () => {
    expect(runValidateWith({ path: '-rf' }).stdout).toContain('must not begin with a dash');
    expect(runValidateWith({ 'sarif-output': '-rf' }).stdout).toContain('must not begin with a dash');
  });

  test('refuses a sarif target under .github/', () => {
    const run = runValidateWith({ 'sarif-output': '.github/workflows/out.sarif' });
    expect(run.status).not.toBe(0);
    expect(run.stdout).toContain('must not write under .github/');
  });

  test('accepts a `./` prefix on a path, which is ordinary Actions style', () => {
    // The first attempt at closing the `./.github/` bypass refused any value
    // containing `./`, which broke `path: ./src`: accepted by every earlier
    // release, and a security upgrade that turns a green check red is one
    // people back out of. The guards normalise now instead of refusing.
    expect(runValidateWith({ path: './src' }).status).toBe(0);
    expect(runValidateWith({ path: './' }).status).toBe(0);
    expect(runValidateWith({ 'sarif-output': './out.sarif' }).status).toBe(0);
  });

  test('refuses every spelling of .github/ that reaches the same directory', () => {
    // The guard compares strings, so every second name for that directory has
    // to be normalised away before the comparison: a `./` prefix, an interior
    // `/./`, a doubled slash, and -- because a macOS runner's filesystem is
    // case-insensitive -- a different case.
    for (const spelling of [
      '.github/workflows/out.sarif',
      './.github/workflows/out.sarif',
      './/.github/out.sarif',
      '.github/./out.sarif',
      '.GitHub/workflows/out.sarif',
      '.GITHUB/out.sarif',
      './.GitHub/out.sarif',
    ]) {
      const run = runValidateWith({ 'sarif-output': spelling });
      expect([spelling, run.status]).not.toEqual([spelling, 0]);
      expect(run.stdout).toContain('must not write under .github/');
    }
    // And a path that merely starts with the same letters is not caught.
    expect(runValidateWith({ 'sarif-output': '.githubbed/out.sarif' }).status).toBe(0);
    expect(runValidateWith({ 'sarif-output': 'out.sarif' }).status).toBe(0);
    expect(runValidateWith({ path: '.' }).status).toBe(0);
  });

  test('refuses a version with a leading zero, which npm reads as a tag', () => {
    // `01.2.3` is not semver, so npm falls back to treating the spec as a
    // dist-tag: the exact family this input claims to refuse.
    for (const bad of ['01.2.3', '00.0.0', '0.6.00', '0.06.0']) {
      const run = runValidateWith({ version: bad });
      expect([bad, run.status]).not.toEqual([bad, 0]);
    }
    expect(runValidateWith({ version: '0.6.0' }).status).toBe(0);
    expect(runValidateWith({ version: '10.20.30' }).status).toBe(0);
  });

  test('tells someone pinned to `latest` what to do instead', () => {
    // A refusal with no alternative in it is a wall. This is the migration
    // the breaking change forces, so the message has to carry the answer.
    const run = runValidateWith({ version: 'latest' });
    expect(run.stdout).toContain('REMOVE the input');
  });
});

describe('action.yml "Report dep-guard result", under GitHub bash flags', () => {
  function runReport(exitCode) {
    const workspace = mkdtempSync(path.join(tmpdir(), 'depguard-action-report-'));
    const scriptFile = path.join(workspace, 'report.sh');
    writeFileSync(scriptFile, extractRunScript('Report dep-guard result'));
    try {
      const stdout = execFileSync(
        'bash',
        ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: { PATH: process.env.PATH ?? '', DG_EXIT_CODE: exitCode },
        }
      );
      return { status: 0, stdout, stderr: '' };
    } catch (err) {
      return {
        status: typeof err.status === 'number' ? err.status : -1,
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? '',
      };
    }
  }

  test('re-raises dep-guard exit codes unchanged', () => {
    expect(runReport('0').status).toBe(0);
    expect(runReport('1').status).toBe(1);
    // The one that must not become 1.
    expect(runReport('2').status).toBe(2);
  });

  test('says exit 2 is not a clean scan, in different words from findings', () => {
    expect(runReport('2').stdout).toContain('could not complete');
    expect(runReport('1').stdout).toContain('blocking findings');
  });

  test('fails rather than passing when no exit code was recorded at all', () => {
    // Reachable now that this step runs under always(): an input that
    // failed validation means the run step never wrote an exit code. A
    // bare `exit ""` is a bash usage error, so the step would have failed
    // for a reason unrelated to the scan, with a confusing message.
    //
    // It re-raises 2, not 1. Nothing scanned the change, which is the same
    // fact as every other could-not-run and a different fact from "there are
    // blocking findings". Exit 1 here would tell a caller the scan reached a
    // verdict it never reached.
    const run = runReport('');
    expect(run.status).toBe(2);
    expect(run.stdout).toContain('did not run to completion');
  });

  test('treats any other code as could not run, never as findings', () => {
    // 126 and 127 are what the SHELL produces when a binary is missing or not
    // executable, which is exactly what a failed install looks like from
    // here. Reporting those as findings would invent a verdict.
    for (const code of ['3', '126', '127']) {
      const run = runReport(code);
      expect([code, run.status]).toEqual([code, 2]);
      expect(run.stdout).toContain('did not produce a result');
      expect(run.stdout).not.toContain('blocking findings');
    }
  });
});

describe('action.yml step wiring', () => {
  test('the upload and report steps run even when an earlier step failed', () => {
    // if: always() is what keeps the upload reachable if anything above
    // it goes wrong. Without it, a failure anywhere earlier skips the
    // upload silently.
    const uploadAt = actionYml.indexOf('- name: Upload SARIF');
    const reportAt = actionYml.indexOf('- name: Report dep-guard result');
    expect(uploadAt).toBeGreaterThan(-1);
    expect(reportAt).toBeGreaterThan(uploadAt);
    const uploadBlock = actionYml.slice(uploadAt, reportAt);
    const reportBlock = actionYml.slice(reportAt);
    expect(uploadBlock).toContain('always()');
    expect(reportBlock).toContain('always()');
  });

  test('does not reintroduce a set line that leaves errexit live', () => {
    // `set -uo pipefail` reads like it configures the shell but leaves
    // GitHub's own -e in place, which is what made the status line
    // unreachable.
    const script = extractRunScript('Run dep-guard');
    expect(script).not.toMatch(/^\s*set -uo pipefail\s*$/m);
    expect(script).toMatch(/set \+e|\|\| SCAN_STATUS=\$\?/);
  });
});
