// The two halves of the world the action's install step runs in: the packages
// the LEGITIMATE registry serves, and the hostile checkout the head controls.
//
// Nothing here is stubbed. The legitimate tarballs are this worktree's own
// packages/core and packages/cli, packed the same way .github/workflows/release.yml
// packs them for publication, so the binary that ends up running really is the
// scanner this repository builds. The hostile checkout is a real git
// repository carrying a real .npmrc and a real node_modules copy, because both
// attack routes are decisions npm makes about files on disk and a fixture that
// only described them would prove nothing.

import { execFileSync } from 'node:child_process';
import {
  accessSync,
  chmodSync,
  constants as fsConstants,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { readTarballEntry } from '../../scripts/lib/tarball.mjs';

// The directories a step is allowed to find a program in, beyond the ones this
// harness builds for it. Deliberately the base system ones and nothing else.
export const SYSTEM_PATH_DIRS = ['/usr/bin', '/bin', '/usr/sbin', '/sbin'];

// Hooks and a template directory are the two things a git repository can carry
// that run code on this machine. The fixture below is built by this file, so
// neither is a live risk here; they are disabled anyway because the harness
// should not depend on the machine's git configuration to be reproducible.
const GIT_FLAGS = [
  '-c',
  'core.hooksPath=',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'user.name=dep-guard action dogfood',
  '-c',
  'user.email=dogfood@example.invalid',
];

function git(cwd, args) {
  execFileSync('git', [...GIT_FLAGS, ...args], {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TEMPLATE_DIR: '', GIT_CONFIG_NOSYSTEM: '1' },
  });
}

function readManifestFromTarball(tarballPath) {
  const entry = readTarballEntry(readFileSync(tarballPath), 'package/package.json');
  if (!entry) {
    throw new Error(`${tarballPath} has no package/package.json`);
  }
  return JSON.parse(entry.toString('utf8'));
}

// npm and pnpm both name a pack file `<name with @ dropped and / replaced by
// a dash>-<version>.tgz`. Computed rather than globbed: two of the packages
// here are `@vaultcompass/dep-guard` at the same version -- the real one and
// the hostile stand-in -- and a glob that matched the wrong one would pass
// this harness while proving the opposite of what it claims.
function packFileName(name, version) {
  return `${name.replace('@', '').replace('/', '-')}-${version}.tgz`;
}

function packageEntry(dir, name, version) {
  const tarballPath = path.join(dir, packFileName(name, version));
  if (!existsSync(tarballPath)) {
    throw new Error(
      `pack did not produce ${packFileName(name, version)} in ${dir}; found ${readdirSync(dir).join(', ')}`
    );
  }
  const manifest = readManifestFromTarball(tarballPath);
  if (manifest.name !== name || manifest.version !== version) {
    throw new Error(
      `${tarballPath} carries ${manifest.name}@${manifest.version}, not ${name}@${version}`
    );
  }
  return { name, version, manifest, tarball: readFileSync(tarballPath) };
}

function manifestAt(dir) {
  return JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'));
}

// The scanner as the registry would serve it, plus its dependency closure.
//
// PACKED, NOT LINKED. `npm install -g` resolves a spec against a registry and
// unpacks a tarball; handing it a directory would exercise a different code
// path from the one a runner takes, and the code path is the thing under test.
// pnpm pack is what release.yml uses, and it rewrites cli's `workspace:*`
// dependency on core to an exact version pin exactly as `pnpm publish` would.
//
// THE DEPENDENCY CLOSURE IS SERVED TOO, because the harness must not touch the
// network: commander and yaml are packed from the copies already installed in
// this worktree. Both are dependency-free, so the closure stops there.
//
// core is packed from a STAGED COPY rather than from the worktree, and the
// staging exists for one reason: `packages/core/data/corpus` is gitignored
// generated data that a development checkout does not have, and without it the
// installed scanner exits 2 with `corpus-missing` before it reads anything.
// That is a failure for a reason this harness is not about, and it would mask
// the difference between the real scanner and a hostile one. Copying rather
// than writing into packages/core keeps the worktree clean: a harness that
// mutates the tree it is packing leaves a mess behind when it is interrupted.
//
// THE FIXTURE CORPUS IS FORCED, not merely defaulted in when a built one is
// absent. This harness's baseline is a claim about the ACTION's install
// boundary -- which program answered, which registry was contacted -- not
// about corpus content, and a real corpus varies by build date and by
// whatever `pnpm corpus:build` last produced on this machine. Preferring a
// real corpus when present would make the baseline's findings (and this
// harness's `--compare`) depend on whether the machine happens to have run
// that build, which is exactly the kind of environment-dependence a fixture
// exists to remove. Every run gets the same fifty-name development fixture,
// whether or not a real corpus sits at `packages/core/data/corpus`.
export function packRealPackages({ repoRoot, workDir }) {
  const packDir = path.join(workDir, 'real-packs');
  mkdirSync(packDir, { recursive: true });

  const cliSrc = path.join(repoRoot, 'packages', 'cli');
  const coreSrc = path.join(repoRoot, 'packages', 'core');
  if (!existsSync(path.join(cliSrc, 'dist', 'cli.js'))) {
    throw new Error(`no built CLI at ${path.join(cliSrc, 'dist', 'cli.js')}; run pnpm build first`);
  }

  const coreStage = path.join(workDir, 'core-stage');
  cpSync(coreSrc, coreStage, {
    recursive: true,
    filter: (source) => path.basename(source) !== 'node_modules',
  });
  const stagedCorpus = path.join(coreStage, 'data', 'corpus');
  // Unconditional: whatever the cpSync above staged from the worktree (a real
  // built corpus, if this machine has one) is replaced, not merely backed up.
  rmSync(stagedCorpus, { recursive: true, force: true });
  cpSync(path.join(coreSrc, 'fixtures', 'corpus'), stagedCorpus, { recursive: true });

  execFileSync('pnpm', ['--dir', coreStage, 'pack', '--pack-destination', packDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  execFileSync('pnpm', ['--dir', cliSrc, 'pack', '--pack-destination', packDir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const cliManifest = manifestAt(cliSrc);
  const coreManifest = manifestAt(coreSrc);
  const cli = packageEntry(packDir, cliManifest.name, cliManifest.version);
  const core = packageEntry(packDir, coreManifest.name, coreManifest.version);

  const deps = [];
  for (const from of [
    path.join(cliSrc, 'node_modules', 'commander'),
    path.join(coreSrc, 'node_modules', 'yaml'),
  ]) {
    if (!existsSync(from)) {
      throw new Error(`${from} is not installed; run pnpm install --frozen-lockfile first`);
    }
    // --ignore-scripts because these are third-party packages and this is
    // packing them, not installing them: a prepack hook in a dependency is
    // exactly the kind of install-time code dep-guard exists to warn about.
    execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir, from], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const depManifest = manifestAt(from);
    deps.push(packageEntry(packDir, depManifest.name, depManifest.version));
  }

  return { cli, core, deps, all: [cli, core, ...deps] };
}

// The scanner the ATTACKER would rather run. Same name, same exact version, so
// the pin in the workflow file is satisfied either way and the only thing that
// decides which one runs is where npm looked.
//
// It exits 0 with a SARIF log carrying no results, which is what makes this a
// real attack rather than a crash: a gate that fails loudly is a gate somebody
// fixes. The marker path is baked into the script rather than passed through
// the environment, because the harness must not add variables to a step's
// environment that action.yml does not declare -- a harness that injects its
// own variables is testing a program that does not exist.
export function buildHostilePackage({ workDir, name, version, markerPath, marker }) {
  // A pack directory of its own. This package deliberately carries the same
  // name and the same exact version as the real one, so its tarball has the
  // same filename, and one directory holding both would hand whichever of them
  // was written second to every caller.
  const packDir = path.join(workDir, 'hostile-packs');
  mkdirSync(packDir, { recursive: true });
  const dir = path.join(workDir, 'hostile-package');
  mkdirSync(dir, { recursive: true });

  writeFileSync(
    path.join(dir, 'package.json'),
    `${JSON.stringify(
      {
        name,
        version,
        description: 'stand-in for a scanner the tree under judgment chose for itself',
        bin: { 'dep-guard': 'dep-guard.sh' },
        files: ['dep-guard.sh'],
      },
      null,
      2
    )}\n`
  );
  writeFileSync(path.join(dir, 'dep-guard.sh'), hostileScript(markerPath, marker));
  chmodSync(path.join(dir, 'dep-guard.sh'), 0o755);

  execFileSync('npm', ['pack', '--ignore-scripts', '--pack-destination', packDir, dir], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return packageEntry(packDir, name, version);
}

// Writes the marker, then prints an empty but VALID SARIF log and exits 0.
//
// Valid matters. An unparseable body would fail the caller's upload step and
// draw attention; an empty run list is a green check with nothing in it, which
// is the outcome an attacker wants and the outcome this harness has to be able
// to see.
function hostileScript(markerPath, marker) {
  return [
    '#!/bin/sh',
    `printf '%s\\n' ${JSON.stringify(marker)} >> ${JSON.stringify(markerPath)}`,
    `echo '{"version":"2.1.0","$schema":"https://json.schemastore.org/sarif-2.1.0.json","runs":[{"tool":{"driver":{"name":"dep-guard","rules":[]}},"results":[]}]}'`,
    'exit 0',
    '',
  ].join('\n');
}

// The checkout GITHUB_WORKSPACE points at: a real git repository whose head
// commit adds a dependency the scanner has something to say about, with the
// base branch present as `origin/main` so pull-request mode can resolve it.
//
// PULL_REQUEST IS THE RUN THAT MATTERS. The head of a pull request is written
// by somebody who is not trusted yet, which is the whole reason the scanner
// has to come from outside the tree. So the fixture is shaped like one: two
// commits, a remote-tracking ref at the base, and GITHUB_BASE_REF set, which
// is what makes the run step pass `--trust-base origin/main`.
//
// The head commit adds a name the corpus does not carry and a near-miss of one
// it does, so the real scanner exits 1. That is the load-bearing half of this
// fixture: a hostile scanner exits 0, so the recorded gate result is the
// difference between a red check and a green one rather than a detail in a log.
export function buildCheckout({ dir, version, evilRegistryOrigin, npmrcKey = 'global', planted }) {
  mkdirSync(dir, { recursive: true });

  const baseManifest = {
    name: 'dep-guard-action-dogfood-fixture',
    version: '1.0.0',
    private: true,
    dependencies: { react: '18.3.1' },
  };
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(baseManifest, null, 2)}\n`);
  writeFileSync(path.join(dir, 'package-lock.json'), `${JSON.stringify(baseLock(), null, 2)}\n`);

  git(dir, ['init', '-q', '-b', 'main']);
  git(dir, ['add', 'package.json', 'package-lock.json']);
  git(dir, ['commit', '-q', '-m', 'base']);
  // The base branch as actions/checkout leaves it: a remote-tracking ref, not
  // a local branch. A bare "main" would not resolve on a detached-HEAD
  // checkout, which is why the run step prefixes origin/.
  git(dir, ['update-ref', 'refs/remotes/origin/main', 'HEAD']);

  const headManifest = {
    ...baseManifest,
    dependencies: { ...baseManifest.dependencies, lodahs: '1.0.0' },
  };
  writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify(headManifest, null, 2)}\n`);
  git(dir, ['add', 'package.json']);
  git(dir, ['commit', '-q', '-m', 'head']);

  // ROUTE ONE: a committed .npmrc repoints the registry.
  //
  // TWO KEYS DO THIS, and the harness runs both. `registry=` is the global one
  // and the simplest form an attacker would commit; `@vaultcompass:registry=`
  // is scope-specific, takes precedence over the global key for this package
  // alone, and is the quieter of the two because every other install in the
  // workflow keeps working normally. Neither may reach the scanner.
  writeFileSync(
    path.join(dir, '.npmrc'),
    npmrcKey === 'scoped'
      ? `@vaultcompass:registry=${evilRegistryOrigin}/\n`
      : `registry=${evilRegistryOrigin}/\n`
  );

  // ROUTE TWO: a copy already in node_modules wins outright. `npx pkg@version`
  // in a tree whose node_modules already satisfies that spec runs the local
  // copy and never contacts a registry at all, so the version pin stops being
  // a choice of program and becomes a satisfaction check on a package the head
  // wrote. Any workflow with an install step before the gate produces this.
  if (planted) {
    const pkgDir = path.join(dir, 'node_modules', '@vaultcompass', 'dep-guard');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      path.join(pkgDir, 'package.json'),
      `${JSON.stringify(
        {
          name: '@vaultcompass/dep-guard',
          version,
          bin: { 'dep-guard': 'dep-guard.sh' },
        },
        null,
        2
      )}\n`
    );
    writeFileSync(path.join(pkgDir, 'dep-guard.sh'), hostileScript(planted.markerPath, planted.marker));
    chmodSync(path.join(pkgDir, 'dep-guard.sh'), 0o755);

    const binDir = path.join(dir, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    writeFileSync(path.join(binDir, 'dep-guard'), hostileScript(planted.markerPath, planted.marker));
    chmodSync(path.join(binDir, 'dep-guard'), 0o755);
  }

  return dir;
}

// A lockfile, so the lockfile-tamper and install-script checks have something
// to read instead of reporting that they were skipped. The entries are shaped
// like npm's own; nothing is ever installed from it.
function baseLock() {
  return {
    name: 'dep-guard-action-dogfood-fixture',
    version: '1.0.0',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': {
        name: 'dep-guard-action-dogfood-fixture',
        version: '1.0.0',
        dependencies: { react: '18.3.1' },
      },
      'node_modules/react': {
        version: '18.3.1',
        resolved: 'https://registry.npmjs.org/react/-/react-18.3.1.tgz',
        integrity:
          'sha512-wS+hAgJShR0KhEvPJArfuPVN1+Hz1t0Y6n5jLrGQbkb4urgPE/0Rve+1kMB1v/oWgHgm4WIcV+i7F2pTVj+2iQ==',
        dependencies: { 'loose-envify': '^1.1.0' },
      },
      'node_modules/loose-envify': {
        version: '1.4.0',
        resolved: 'https://registry.npmjs.org/loose-envify/-/loose-envify-1.4.0.tgz',
        integrity:
          'sha512-lyuxPGr/Wfhrlem2CL/UcnUc1zcqKAImBDzukY7Y5F/yQiNdko6+fRLevlw1HgMySw7f611UIY408EtxRSoK3Q==',
        dependencies: { 'js-tokens': '^3.0.0 || ^4.0.0' },
      },
      'node_modules/js-tokens': {
        version: '4.0.0',
        resolved: 'https://registry.npmjs.org/js-tokens/-/js-tokens-4.0.0.tgz',
        integrity:
          'sha512-RdJUflcE3cUzKiMqQgsCu06FPu9UdIJO0beYbPhHN4k6apgJtifcoCtT9bcxOpYBtpD2kCM6Sbzg4CausW/PKQ==',
      },
    },
  };
}

// The RUNNER's own npm configuration, which is a different file from the one
// in the checkout and is the whole point of the distinction. A real runner
// reads a user-level ~/.npmrc that the pull request cannot write; the checkout
// gets a project-level .npmrc that it can. Pointing this one at the legitimate
// server and the other at the hostile one is what makes "which registry
// answered" a readable answer rather than a coincidence.
//
// The first directory on `searchPath` holding an executable file called
// `name`, or null. Pure path arithmetic and a stat, so it can be unit-tested
// and so the harness can ask the question about a PATH it has not run
// anything with yet.
export function resolveOnPath(name, searchPath) {
  for (const dir of searchPath.split(path.delimiter)) {
    if (dir.length === 0) continue;
    const candidate = path.join(dir, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, fsConstants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable. Next.
    }
  }
  return null;
}

// A PATH the harness controls, holding exactly the programs a step needs.
//
// THIS IS NOT TIDINESS, IT IS THE DIFFERENCE BETWEEN A RESULT AND A FICTION.
// The machine this was first run on had `@vaultcompass/dep-guard` installed
// globally at the very version the fixture pins. `npm exec pkg@version`
// accepts a binary already on PATH when the package behind it satisfies the
// spec, so npx read the hostile packument, found the operator's global copy
// good enough, and ran THAT -- and the harness recorded a clean, real-scanner
// run for the vulnerable action. The attack had not failed; the harness had
// stopped being able to see it, and the honest-looking result was the bug.
//
// So the inherited PATH is thrown away. Each tool a step needs is wrapped by a
// one-line script that execs the real absolute path, which keeps npm and npx
// working out of a node installation whose bin directory this PATH never
// contains. Anything else a step reaches for comes from the base system
// directories or does not resolve at all.
export function buildToolBin({ dir, tools, sourcePath = process.env.PATH ?? '' }) {
  mkdirSync(dir, { recursive: true });
  const resolved = {};
  for (const tool of tools) {
    const target = resolveOnPath(tool, sourcePath);
    if (target === null) {
      throw new Error(`${tool} is not on PATH, so the harness cannot give a step a way to run it`);
    }
    const wrapper = path.join(dir, tool);
    writeFileSync(wrapper, `#!/bin/sh\nexec ${JSON.stringify(target)} "$@"\n`);
    chmodSync(wrapper, 0o755);
    resolved[tool] = target;
  }
  return { dir, resolved };
}

// The PATH a step actually runs with, and the ordering is the adversarial one:
// the CHECKOUT'S OWN node_modules/.bin comes first, which is what a workflow
// with an install step before the gate produces. Without that ordering, "the
// planted copy never ran" would hold for the uninteresting reason that nothing
// could have reached it.
export function stepPath({ workspace, toolBinDir }) {
  return [path.join(workspace, 'node_modules', '.bin'), toolBinDir, ...SYSTEM_PATH_DIRS].join(
    path.delimiter
  );
}

// `prefix` is the second half of the isolation, and PATH alone does not get
// it. `npm exec pkg@version` will run a binary it finds in the GLOBAL bin
// directory when the package behind it satisfies the spec, and it finds that
// directory from npm's own `prefix` config rather than by searching PATH. Left
// at the default it is the node installation's own prefix, so on a developer
// machine with the scanner installed globally npx read the hostile packument,
// matched the operator's copy, ran it, and the harness recorded the vulnerable
// action as clean. Pointing prefix at an empty directory is what a CI runner
// looks like anyway; here it is what keeps a machine's own installs out of the
// result. The install step's own `npm_config_prefix` still wins over this,
// because an environment variable beats a user config file.
//
// audit, fund and the update notifier are turned off because each of them
// reaches for a host this harness does not run, and a hang or a stray 404 in
// the request log would be noise in the recorded result. All of it is runner
// configuration, not action configuration: the install step's command line is
// taken from action.yml unchanged.
export function buildRunnerHome({ dir, legitRegistryOrigin, npmPrefix }) {
  mkdirSync(dir, { recursive: true });
  mkdirSync(npmPrefix, { recursive: true });
  writeFileSync(
    path.join(dir, '.npmrc'),
    [
      `registry=${legitRegistryOrigin}/`,
      `prefix=${npmPrefix}`,
      'audit=false',
      'fund=false',
      'update-notifier=false',
      'progress=false',
      '',
    ].join('\n')
  );
  return dir;
}
