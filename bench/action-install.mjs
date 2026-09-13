#!/usr/bin/env node
// Runs action.yml's own install and run steps against REAL npm, with a
// checkout that mounts both attacks the install boundary exists to close, and
// records which scanner ended up doing the scanning.
//
//   pnpm build
//   node bench/action-install.mjs --compare
//   node bench/action-install.mjs --write-baseline
//   node bench/action-install.mjs --action-file /path/to/some/action.yml
//
// WHY THIS EXISTS. scripts/tests/action-run-script.test.mjs executes the same
// step scripts under the same shell flags, and it STUBS npm. That proves the
// action no longer asks npm to run from inside the checkout. It cannot prove
// what real npm does when it is asked to, because a stub does whatever the
// stub says. Both attack routes are decisions the real client makes:
//
//   1. A committed .npmrc repoints the registry npm fetches from. npx in
//      non-global mode reads project configuration from its cwd, so a pull
//      request adding one root file chooses where the scanner comes from.
//   2. A copy already in the checkout's node_modules wins outright.
//      `npx pkg@version` in a tree that already satisfies that spec runs the
//      local copy and never contacts a registry, so the version pin degrades
//      from a choice of program into a satisfaction check on a package the
//      head wrote.
//
// Both were exercised by hand against real npm when the fix was written, and
// docs/INVARIANTS.md recorded that nothing in this repository pinned either of
// them. This is what pins them.
//
// NO NETWORK. Two registries run on 127.0.0.1 on ephemeral ports for the life
// of the run. The legitimate one serves this worktree's own packages/core and
// packages/cli, packed the way release.yml packs them, plus their dependency
// closure. The hostile one serves a stand-in at the same name and the same
// exact version whose bin writes a marker and exits 0 with an empty SARIF log.
// Pointing a proven attack at a public registry is not a thing to do on
// purpose, and a harness that needs the internet is a harness that stops being
// run.
//
// THE NEGATIVE CONTROL IS THE POINT. --action-file defaults to this
// worktree's action.yml, and the baseline records the PRE-FIX action from tag
// v0.6.0 alongside it, read out of git at run time rather than committed as a
// second copy. A harness that reports the current action clean proves nothing
// on its own: it has to be shown catching the attack on the action that had
// it. If the v0.6.0 cases ever stop showing the attack, this harness has
// stopped being able to see the thing it exists to watch for, and --compare
// fails on that just as loudly as on a regression.

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadAction } from '../scripts/lib/action-steps.mjs';
import {
  buildCheckout,
  buildHostilePackage,
  buildRunnerHome,
  buildToolBin,
  packRealPackages,
  resolveOnPath,
  stepPath,
} from './lib/action-fixture.mjs';
import { startRegistry } from './lib/action-registry.mjs';
import { compareRuns, formatRunComparison, formatTable } from './lib/action-result.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = path.join(REPO_ROOT, 'bench', 'baseline.action-install.json');

const INSTALL_STEP = 'Install dep-guard outside the workspace';
const RUN_STEP = 'Run dep-guard';

// The action revision the boundary was introduced in is not the one to test
// against; the one BEFORE it is. v0.6.0 ran npx from inside the checkout.
const PRE_FIX_REF = 'v0.6.0';

// Generous, because a step here does a real install; short enough that a hang
// is a failed run rather than a harness nobody can finish. A step that reaches
// it is recorded as status -1, which never matches a baseline.
const STEP_TIMEOUT_MS = 180_000;

const USAGE = `Usage: node bench/action-install.mjs [options]

  --action-file <path>  the action.yml to run (default: this worktree's)
  --compare             compare against the recorded baseline, exit 1 on drift
  --write-baseline      record this run as the baseline
  --json                write the run to stdout as JSON
  --keep                leave the per-case work directories on disk
  -h, --help            print this
`;

function log(message) {
  process.stderr.write(`${message}\n`);
}

function parseArgs(argv) {
  const options = {
    actionFile: null,
    compare: false,
    writeBaseline: false,
    json: false,
    keep: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (arg === '--compare') {
      options.compare = true;
      continue;
    }
    if (arg === '--write-baseline') {
      options.writeBaseline = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (arg === '--keep') {
      options.keep = true;
      continue;
    }
    const value = argv[index + 1];
    if (typeof value !== 'string' || value.startsWith('-')) {
      throw new Error(`${arg} needs a value`);
    }
    index += 1;
    if (arg === '--action-file') {
      options.actionFile = path.resolve(value);
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

// The pre-fix action, read out of git rather than committed.
//
// A checked-in copy of a vulnerable action.yml in a public repository is a
// file somebody eventually copies, and a file every scanner that reads this
// repository has to be told to ignore. The tag already holds it.
function writePreFixAction(intoDir) {
  const text = execFileSync('git', ['show', `${PRE_FIX_REF}:action.yml`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
  const file = path.join(intoDir, 'action.pre-fix.yml');
  writeFileSync(file, text);
  return file;
}

// A composite `shell: bash` step, run the way GitHub runs one:
//
//   bash --noprofile --norc -eo pipefail {0}
//
// Errexit is already on before the script's first line, which is the flag
// state the run step's comments are about, so the harness must not soften it.
//
// ASYNCHRONOUS, AND THAT IS NOT A STYLE CHOICE. The two registries are HTTP
// servers in this process. `spawnSync` blocks the event loop for as long as
// the child runs, so npm's first request would sit unanswered on a socket
// nothing was ever going to accept, and the step would hang until its timeout
// with both request logs empty -- which reads exactly like "npm never
// contacted either registry", the single most load-bearing observation this
// harness makes. A blocking spawn here does not slow the harness down, it
// makes it lie.
//
// `detached` plus a kill of the whole process GROUP on timeout, because the
// child is bash and the thing that hangs is npm underneath it: signalling
// bash alone leaves an orphaned npm running against a registry that is about
// to be closed.
function runStepScript({ action, stepName, ctx, env, workDir, label }) {
  const scriptFile = path.join(workDir, `${label}.sh`);
  writeFileSync(scriptFile, action.extractRunScript(stepName));
  return new Promise((resolve) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', scriptFile], {
      cwd: action.cwdForStep(stepName, ctx),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, STEP_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ status: -1, stdout, stderr: `${stderr}${err}`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      writeFileSync(path.join(workDir, `${label}.stdout`), stdout);
      writeFileSync(path.join(workDir, `${label}.stderr`), stderr);
      resolve({ status: timedOut ? -1 : code, stdout, stderr, timedOut });
    });
  });
}

function parseOutputs(file) {
  const outputs = {};
  if (!existsSync(file)) return outputs;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const at = line.indexOf('=');
    if (at > 0) outputs[line.slice(0, at)] = line.slice(at + 1);
  }
  return outputs;
}

// Which program wrote the SARIF, read out of the SARIF itself.
//
// The hostile stand-ins deliberately name themselves "dep-guard" in the tool
// driver, because an attacker would: a log that announced itself as something
// else is one a reviewer notices. So the discriminator is not the name. It is
// that the real scanner emits its own version and a full rule catalogue and,
// on this fixture, two results; a stand-in that has to fake a clean run emits
// none of that.
function classifySarif(file) {
  if (!existsSync(file)) return { kind: 'absent', ruleIds: [], ruleCatalogue: 0 };
  const text = readFileSync(file, 'utf8');
  if (text.trim().length === 0) return { kind: 'empty', ruleIds: [], ruleCatalogue: 0 };
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { kind: 'unparseable', ruleIds: [], ruleCatalogue: 0 };
  }
  const run = parsed?.runs?.[0];
  const driver = run?.tool?.driver ?? {};
  const ruleIds = (run?.results ?? []).map((r) => r.ruleId).sort();
  const ruleCatalogue = (driver.rules ?? []).length;
  return {
    kind: typeof driver.version === 'string' && ruleCatalogue > 0 ? 'real-scanner' : 'stand-in',
    ruleIds,
    ruleCatalogue,
  };
}

// Whether the scanner that the install step left behind is the one under the
// runner temp, checked by reading the manifest npm wrote rather than by
// trusting the path the run step was told to call.
function inspectInstalledScanner(prefix) {
  const manifestPath = path.join(prefix, 'lib', 'node_modules', '@vaultcompass', 'dep-guard', 'package.json');
  if (!existsSync(manifestPath)) {
    return { present: false, underRunnerPrefix: false, version: null };
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  return {
    present: true,
    underRunnerPrefix: manifestPath.startsWith(`${prefix}${path.sep}`),
    version: manifest.version ?? null,
  };
}

const HOSTILE_REGISTRY_MARKER = 'HOSTILE-REGISTRY-COPY-RAN';
const PLANTED_MARKER = 'PLANTED-NODE-MODULES-COPY-RAN';

// The programs a step is allowed to find. npm and npx need node; the scanner
// shells out to git for the trust base. Everything else a step reaches for
// (mkdir, dirname) comes from the base system directories.
const STEP_TOOLS = ['node', 'npm', 'npx', 'git'];

// One case: one action.yml revision, one shape of hostile checkout.
async function runCase({ caseId, actionFile, scenario, packages, version, root, toolBin }) {
  const workDir = path.join(root, caseId);
  mkdirSync(workDir, { recursive: true });

  const hostileMarker = path.join(workDir, 'hostile-registry-marker.txt');
  const plantedMarker = path.join(workDir, 'planted-marker.txt');

  const hostile = buildHostilePackage({
    workDir,
    name: packages.cli.name,
    version,
    markerPath: hostileMarker,
    marker: HOSTILE_REGISTRY_MARKER,
  });

  const legit = await startRegistry({ label: 'legit', packages: packages.all });
  const evil = await startRegistry({ label: 'evil', packages: [hostile] });

  try {
    const workspace = buildCheckout({
      dir: path.join(workDir, 'workspace'),
      version,
      evilRegistryOrigin: evil.origin,
      npmrcKey: scenario.npmrcKey,
      planted: scenario.planted ? { markerPath: plantedMarker, marker: PLANTED_MARKER } : null,
    });
    const runnerTemp = path.join(workDir, 'runner-temp');
    mkdirSync(runnerTemp, { recursive: true });
    const npmPrefix = path.join(workDir, 'npm-global-prefix');
    const home = buildRunnerHome({
      dir: path.join(workDir, 'runner-home'),
      legitRegistryOrigin: legit.origin,
      npmPrefix,
    });

    const action = loadAction(actionFile);
    // The version input is the exact version the packed packages carry, which
    // is also the version the hostile stand-in claims. A pin both sides
    // satisfy is the interesting case: it is the one where the pin cannot be
    // what decides, and only where npm looked can.
    const ctx = {
      inputs: {
        version,
        path: '.',
        online: 'false',
        'fail-on': '',
        'sarif-output': 'dep-guard-results.sarif',
        'upload-sarif': 'true',
        'trust-base': '',
      },
      runnerTemp,
      workspace,
    };

    const outputFile = path.join(workDir, 'github-output');
    writeFileSync(outputFile, '');

    // A PATH THE HARNESS BUILT, never the operator's. See buildToolBin: the
    // machine this was first run on had the scanner installed globally at the
    // pinned version, `npm exec` accepted that copy as satisfying the spec,
    // and the vulnerable action recorded a clean run. The checkout's own
    // node_modules/.bin still goes first, because that ordering is the
    // adversarial condition; everything after it is wrappers plus the base
    // system directories.
    //
    // GITHUB_BASE_REF is set because pull_request is the run this boundary is
    // about, and it is what makes the run step pass --trust-base origin/main.
    // Like GITHUB_WORKSPACE and GITHUB_OUTPUT it comes from the runner rather
    // than from a step's env: mapping. Everything a STEP declares comes out of
    // action.yml and nowhere else.
    const searchPath = stepPath({ workspace, toolBinDir: toolBin.dir });

    // Proven, not assumed, and proven for THIS case. In a scenario with no
    // planted copy nothing at all should answer to the name, and if something
    // does, every "the attack did not land" reading below is worth nothing:
    // the run would be picking up a bystander.
    //
    // The global bin directory is searched alongside PATH because that is
    // where `npm exec` looks and PATH is not: a copy sitting there is invisible
    // to a PATH check and was exactly the bystander that made an earlier
    // version of this harness report the vulnerable action clean.
    const strayScanner = resolveOnPath(
      'dep-guard',
      [searchPath, path.join(npmPrefix, 'bin')].join(path.delimiter)
    );
    if (!scenario.planted && strayScanner !== null) {
      throw new Error(
        `a dep-guard binary is reachable at ${strayScanner} before anything installed one, ` +
          'so this case could not tell an isolated run from a lucky one'
      );
    }

    const runnerEnv = {
      PATH: searchPath,
      HOME: home,
      GITHUB_WORKSPACE: workspace,
      GITHUB_OUTPUT: outputFile,
      GITHUB_BASE_REF: 'main',
    };

    const steps = {};
    const installPresent = action.hasStep(INSTALL_STEP);
    if (installPresent) {
      const install = await runStepScript({
        action,
        stepName: INSTALL_STEP,
        ctx,
        env: { ...runnerEnv, ...action.evaluateStepEnv(INSTALL_STEP, ctx) },
        workDir,
        label: 'install',
      });
      steps.install = { present: true, status: install.status };
    } else {
      // v0.6.0 has no install step at all: it installed nothing and ran npx
      // from inside the checkout. Recorded rather than skipped silently,
      // because the absence is the vulnerability.
      steps.install = { present: false, status: null };
    }

    const run = await runStepScript({
      action,
      stepName: RUN_STEP,
      ctx,
      env: { ...runnerEnv, ...action.evaluateStepEnv(RUN_STEP, ctx) },
      workDir,
      label: 'run',
    });
    steps.run = { present: true, status: run.status };

    const outputs = parseOutputs(outputFile);
    const sarif = classifySarif(path.join(workspace, ctx.inputs['sarif-output']));
    const installed = inspectInstalledScanner(path.join(runnerTemp, 'dep-guard-action'));

    const markers = {
      hostileRegistryCopyRan: existsSync(hostileMarker),
      plantedCopyRan: existsSync(plantedMarker),
    };

    // ONE WORD FOR WHAT ACTUALLY SCANNED, so a reader of the baseline does not
    // have to reassemble it from five fields. The marker files are checked
    // first: either of them means a program the checkout supplied did the
    // scanning, whatever else the run looks like.
    const scannerThatRan = markers.plantedCopyRan
      ? 'planted-copy'
      : markers.hostileRegistryCopyRan
        ? 'hostile-registry'
        : sarif.kind === 'real-scanner'
          ? 'installed-real'
          : `none-${sarif.kind}`;

    return {
      id: caseId,
      action: scenario.actionLabel,
      scenario: scenario.label,
      observed: {
        scannerThatRan,
        steps,
        markers,
        evilRegistry: {
          requestCount: evil.requests.length,
          paths: [...new Set(evil.paths())].sort(),
        },
        legitRegistry: {
          contacted: legit.requests.length > 0,
          paths: [...new Set(legit.paths())].sort(),
        },
        installedScanner: installed,
        sarif: { kind: sarif.kind, ruleIds: sarif.ruleIds, ruleCatalogue: sarif.ruleCatalogue },
        gate: {
          // What the report step re-raises, so this is the check's colour: 0
          // green, 1 blocking findings, 2 could not run. The fixture's head
          // commit adds a dependency the real scanner objects to, so a red
          // gate here that goes green is the attack, stated as an outcome.
          exitCode: outputs.exit_code ?? '',
          resultsFileRecorded: (outputs.results_file ?? '') !== '',
        },
      },
    };
  } finally {
    await evil.close();
    await legit.close();
  }
}

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`action-install: ${err.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }

  const startedAt = Date.now();
  const root = mkdtempSync(path.join(tmpdir(), 'dep-guard-action-dogfood-'));
  try {
    log('packing this worktree as the registry would serve it');
    const packages = packRealPackages({ repoRoot: REPO_ROOT, workDir: root });
    const version = packages.cli.version;
    log(`  ${packages.all.map((p) => `${p.name}@${p.version}`).join(', ')}`);

    const toolBin = buildToolBin({ dir: path.join(root, 'tool-bin'), tools: STEP_TOOLS });

    const currentAction = options.actionFile ?? path.join(REPO_ROOT, 'action.yml');
    // Only the default run carries the negative control. Pointing --action-file
    // at some other revision is a one-off investigation, and pairing it with a
    // v0.6.0 control it was not asked about would make the output harder to
    // read, not easier.
    const revisions =
      options.actionFile === null
        ? [
            { label: 'current', file: currentAction },
            { label: PRE_FIX_REF, file: writePreFixAction(root) },
          ]
        : [{ label: 'given', file: currentAction }];

    const scenarios = [
      // Both routes at once, which is what a workflow with an install step
      // before the gate actually looks like.
      { label: 'npmrc-and-planted-copy', npmrcKey: 'global', planted: true },
      // The registry route on its own. Needed as a case of its own because
      // with a planted copy present npx never reaches a registry at all, so
      // the hostile registry's request log cannot say anything either way.
      { label: 'npmrc-only', npmrcKey: 'global', planted: false },
      // The same route through the scope-specific key, which takes precedence
      // over the global one for this package and leaves every other install in
      // the workflow working normally.
      { label: 'scoped-npmrc-only', npmrcKey: 'scoped', planted: false },
    ];

    const cases = [];
    for (const revision of revisions) {
      for (const scenario of scenarios) {
        const caseId = `${revision.label}--${scenario.label}`;
        log(caseId);
        const result = await runCase({
          caseId,
          actionFile: revision.file,
          scenario: { ...scenario, actionLabel: revision.label },
          packages,
          version,
          root,
          toolBin,
        });
        log(
          `  scanner: ${result.observed.scannerThatRan}, gate exit ${result.observed.gate.exitCode || '(none)'}, ` +
            `${result.observed.evilRegistry.requestCount} request(s) to the hostile registry`
        );
        cases.push(result);
      }
    }

    const runRecord = { version: 1, scannerVersion: version, cases };

    process.stdout.write(`${formatTable(cases)}\n`);
    log(`\n${cases.length} case(s) in ${Math.round((Date.now() - startedAt) / 1000)}s`);

    if (options.writeBaseline) {
      writeFileSync(BASELINE, `${JSON.stringify(runRecord, null, 2)}\n`);
      log(`Recorded this run as the baseline at ${path.relative(REPO_ROOT, BASELINE)}`);
    }

    if (options.compare) {
      if (!existsSync(BASELINE)) {
        throw new Error(`no baseline at ${BASELINE}; run with --write-baseline first`);
      }
      const comparison = compareRuns(runRecord, JSON.parse(readFileSync(BASELINE, 'utf8')));
      log('');
      log(formatRunComparison(comparison));
      if (comparison.changed) {
        process.exitCode = 1;
      }
    }

    if (options.json) {
      process.stdout.write(`${JSON.stringify(runRecord, null, 2)}\n`);
    }
  } finally {
    if (options.keep) {
      log(`work directories left at ${root}`);
    } else {
      rmSync(root, { recursive: true, force: true });
    }
  }
}

main().catch((err) => {
  process.stderr.write(`action-install: ${err?.stack ?? String(err)}\n`);
  process.exitCode = 2;
});
