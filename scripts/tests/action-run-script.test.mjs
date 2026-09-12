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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
// Overridable so a mutation run can point the whole suite at a deliberately
// weakened copy and watch which assertions go red. Nothing in CI sets it, and
// the default is the real file. A test that cannot be made to fail on demand
// is a test nobody has checked.
const ACTION_PATH = process.env.DG_ACTION_FILE ?? path.join(ROOT, 'action.yml');
const actionYml = readFileSync(ACTION_PATH, 'utf8');

// Pulls one step's `run:` block out of action.yml by step name, keeping
// the real file the single source of truth. A copy of the script pasted
// into this test would pass forever after action.yml drifted away from
// it, which is the exact failure mode the sibling test file's textual
// guards exist to prevent.
function extractRunScript(stepName) {
  const lines = actionYml.split('\n');
  const stepAt = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (stepAt === -1) {
    throw new Error(`no step named ${stepName} in action.yml`);
  }
  const runAt = lines.findIndex((l, i) => i > stepAt && l.trim() === 'run: |');
  if (runAt === -1) {
    throw new Error(`step ${stepName} has no "run: |" block`);
  }
  const indent = lines[runAt].length - lines[runAt].trimStart().length + 2;
  const body = [];
  for (let i = runAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) {
      body.push('');
      continue;
    }
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) {
      break;
    }
    body.push(line.slice(indent));
  }
  return body.join('\n');
}

// The step's own `env:` mapping, as declared in action.yml.
//
// EVERY VARIABLE THIS HARNESS SUPPLIES COMES FROM HERE, never from a table
// written in this file. A harness that injects a variable the step does not
// declare is testing a program that does not exist: on a real runner the
// script would see that value empty, and the suite would stay green while the
// action quietly stopped reading one of its own inputs.
function extractStepEnv(stepName) {
  const lines = actionYml.split('\n');
  const stepAt = lines.findIndex((l) => l.trim() === `- name: ${stepName}`);
  if (stepAt === -1) {
    throw new Error(`no step named ${stepName} in action.yml`);
  }
  const envAt = lines.findIndex((l, i) => i > stepAt && l.trim() === 'env:');
  if (envAt === -1 || envAt > lines.findIndex((l, i) => i > stepAt && l.trim() === 'run: |')) {
    throw new Error(`step ${stepName} has no env: block before its run: block`);
  }
  const indent = lines[envAt].length - lines[envAt].trimStart().length + 2;
  const env = {};
  for (let i = envAt + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim().length === 0) continue;
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) break;
    if (lineIndent > indent || line.trim().startsWith('#')) continue;
    const match = /^([A-Za-z_][A-Za-z0-9_]*):\s*(.*)$/.exec(line.trim());
    if (match) env[match[1]] = match[2];
  }
  return env;
}

// The `${{ }}` expressions this action uses, and nothing else. Throwing on an
// unmodelled one is deliberate: a step that started reading a context this
// harness does not know about would otherwise be tested with that value blank.
function evaluateTemplate(template, ctx) {
  return template.replace(/\$\{\{\s*([^}]+?)\s*\}\}/g, (_m, raw) => {
    const expression = raw.trim();
    if (expression.startsWith('inputs.')) {
      const name = expression.slice('inputs.'.length);
      if (!(name in ctx.inputs)) {
        throw new Error(`action.yml reads inputs.${name}, which this test did not set`);
      }
      return ctx.inputs[name];
    }
    if (expression === 'runner.temp') return ctx.runnerTemp;
    throw new Error(`the harness cannot evaluate the expression ${expression}`);
  });
}

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

  const ctx = { inputs: { ...DEFAULT_INPUTS, ...inputs }, runnerTemp };
  const env = evaluateStepEnv('Run dep-guard', ctx);

  const plantedRecord = path.join(dir, 'planted.txt');
  const npxRecord = path.join(dir, 'npx.txt');
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

  return { dir, workspace, runnerTemp, ctx, env, plantedRecord, npxRecord, pathDir };
}

function evaluateStepEnv(stepName, ctx) {
  const templates = extractStepEnv(stepName);
  const env = {};
  for (const [key, template] of Object.entries(templates)) {
    env[key] = evaluateTemplate(template, ctx);
  }
  return env;
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
    cwd: runner.runnerTemp,
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
      cwd: runner.runnerTemp,
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

  test('scans an absolute path, so the scan root survives the move', () => {
    // The half of this fix that is easy to leave out. Run from the runner temp
    // with a relative `.`, dep-guard resolves the runner temp as the
    // repository, fails to resolve the trust base, and exits 2 on every run,
    // blaming a fetch-depth the caller already set.
    const argv = argvFor({ 'sarif-output': 'args.txt' });
    expect(argv).toContain('/workspace');
    expect(argv.split(/\s+/).some((a) => a.startsWith('/'))).toBe(true);
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
