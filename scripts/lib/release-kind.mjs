// Decides what kind of release a pushed tag is, and refuses the tag
// outright if it is neither kind.
//
// This repository ships two things from one tree: the npm packages
// (@vaultcompass/dep-guard-core and @vaultcompass/dep-guard, versioned in
// lockstep) and the composite GitHub Action at the repository root, whose
// `version` input defaults to the scanner version that action tag ships.
// Those two numbers are allowed to come apart -- see the "The action tag
// and the scanner version are two numbers" section of docs/INVARIANTS.md
// -- and v0.6.1 was the first release where they did: action.yml, README,
// CHANGELOG and docs moved, the packages stayed at 0.6.0.
//
// The classify API is the vault-guard packages[] shape (vault-guard 1.8.0
// on main, scripts/lib/release-kind.mjs as of c166862): every published
// package is one {name, version} entry. Lockstep, the five action-only
// conditions, and the package-release default check are unchanged for the
// current two-package layout.
//
// The property the old assertion bought has to survive admitting the
// second shape: a mistyped or mis-pointed tag must never publish anything,
// and must never describe an unpublished version in a Release. An
// action-only tag is therefore not "any tag that is not an exact match" --
// it is a tag that clears all of the conditions below, each of which
// closes off one way a typo could get through:
//
//   a. exact semver, no prerelease or build suffix, no leading zeros --
//      the same shape action.yml validates its own version input against,
//      so a tag this repo blesses is a tag the action could be pinned to;
//   b. strictly greater than the package version by NUMERIC semver
//      ordering, so a tag onto an older line ("v0.9.0" while the packages
//      are at 0.10.0, which string comparison reads as a forward move) is
//      a mistake rather than a release;
//   c. every published package ALREADY on the registry at exactly the
//      package version, which is what makes "describes nothing unpublished"
//      true rather than merely likely;
//   d. action.yml's version default equal to the package version, because
//      an action-only tag ships the scanner that is already published --
//      if the default moved, the scanner changed and this is a package
//      release whose packages were never bumped.
//   e. a CHANGELOG.md entry for the tag version, because every condition
//      above is also satisfied by a forgotten bump pushed as a new tag,
//      and what separates that from a release is that somebody wrote it
//      down.
//
// The package path is not left unchecked either: it also requires
// action.yml's version default to equal the version being published, or
// the tag the release creates would install a different scanner than the
// release put on npm.
//
// The registry lookup is injected rather than imported so the tests can
// run offline; scripts/classify-release-tag.mjs supplies the real one.

// The same pattern action.yml validates its `version` input with. Kept
// character for character: a tag shape this repo accepts but the action
// rejects would be a tag nobody could pin to.
export const EXACT_SEMVER = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

/**
 * Parses an exact semver string into a [major, minor, patch] triple, or
 * returns null if it is anything else -- a prerelease, a build suffix, a
 * leading-zero component, a two-part version, a dist-tag, a "v" prefix.
 */
export function parseExactSemver(value) {
  if (typeof value !== 'string') {
    return null;
  }
  const match = EXACT_SEMVER.exec(value);
  if (match === null) {
    return null;
  }
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** Numeric, component-wise ordering. Negative, zero or positive. */
export function compareExactSemver(a, b) {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) {
      return a[i] - b[i];
    }
  }
  return 0;
}

/**
 * Reads the `default:` of action.yml's `version` input.
 *
 * Deliberately not a "first default: after version:" grep, and scoped
 * three ways, each closing off a different way of reading the wrong
 * number:
 *
 *   * only inside the top-level `inputs:` block. `version` is a plausible
 *     key elsewhere in an action file -- an `outputs:` block is the
 *     obvious one -- and a reader that took the first `  version:` in the
 *     file would compare the tag against whatever that other block said.
 *   * only lines at exactly four spaces, so the `version` input's long
 *     description block scalar, which names example versions and uses the
 *     word "default" in prose, cannot be mistaken for the key.
 *   * exactly one `default:` in the block, or it throws. Two would mean
 *     the file says two different things about what this action installs,
 *     and picking either one is a guess; YAML itself would resolve a
 *     duplicate key silently by taking the last, which is precisely the
 *     kind of quiet answer a release gate must not give.
 *
 * A real YAML parser would be better, but this file runs in the release
 * job BEFORE `pnpm install` (on purpose -- the whole point is to catch a
 * tag-time mistake before a fifteen-minute corpus walk), so it gets node
 * builtins and nothing else. Every failure here is fatal rather than a
 * fallback: not being able to read this number means not being able to
 * check it.
 */
export function readActionVersionDefault(actionYmlText) {
  const lines = String(actionYmlText).split('\n');

  const inputsAt = lines.findIndex((line) => /^inputs:\s*$/.test(line));
  if (inputsAt === -1) {
    throw new Error(
      'action.yml has no top-level `inputs:` block, so the scanner version this action tag ships could not be read.'
    );
  }

  // The inputs block ends at the next top-level key (`runs:`, `outputs:`).
  let inputsEnd = lines.length;
  for (let i = inputsAt + 1; i < lines.length; i += 1) {
    if (/^\S/.test(lines[i])) {
      inputsEnd = i;
      break;
    }
  }

  let start = -1;
  for (let i = inputsAt + 1; i < inputsEnd; i += 1) {
    if (/^ {2}version:\s*$/.test(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    throw new Error(
      'action.yml has no `version:` input inside its `inputs:` block, so the scanner version this action tag ships could not be read.'
    );
  }

  const found = [];
  for (let i = start + 1; i < inputsEnd; i += 1) {
    const line = lines[i];
    // The next key at this input's own level, or any key shallower than
    // it, ends this input's block.
    if (/^ {0,2}\S/.test(line) && line.trim() !== '') {
      break;
    }
    const match = /^ {4}default:\s*(.*)$/.exec(line);
    if (match !== null) {
      found.push(match[1].trim().replace(/^['"]|['"]$/g, ''));
    }
  }

  if (found.length === 0) {
    throw new Error(
      "action.yml's `version:` input has no `default:` at the expected indentation, so the scanner version this action tag ships could not be read."
    );
  }
  if (found.length > 1) {
    throw new Error(
      `action.yml's \`version:\` input has ${found.length} \`default:\` keys (${found.join(', ')}). Which scanner this action tag installs is then ambiguous, and a release gate does not get to guess. Fix action.yml.`
    );
  }

  return found[0];
}

/**
 * A package release publishes version X and creates the tag vX, and that
 * tag is what people put in `uses:`. So action.yml's version default has
 * to be X as well, or the action that tag ships installs a different
 * scanner than the release published -- the exact split docs/INVARIANTS.md
 * warns about under "The action tag and the scanner version are two
 * numbers", in the one direction where nobody chose it on purpose.
 *
 * Skipped when the package version carries a prerelease or is otherwise
 * not exact semver: action.yml's version input refuses a prerelease pin
 * outright, so there is no default it could legally carry that would equal
 * such a version, and demanding one would make a prerelease package
 * release impossible rather than safe.
 */
function assertPackageReleaseDefault({ version, actionYmlText, refDescription }) {
  if (parseExactSemver(version) === null) {
    return;
  }

  const actionDefault = readActionVersionDefault(actionYmlText);
  if (actionDefault !== version) {
    throw new Error(
      `This is a package release of version ${version} (${refDescription}), but action.yml's version input defaults to ${actionDefault}. The tag this release creates would install scanner ${actionDefault} while publishing ${version} -- a different scanner than it publishes. Move the default with the packages. Refusing to publish.`
    );
  }
}

/**
 * @param {object} input
 * @param {string|null} input.tagName        the pushed tag, or null on workflow_dispatch
 * @param {string} input.refDescription      how to name this ref in an error message
 * @param {{name: string, version: string}[]} input.packages
 *        every package this repository publishes to npm, in the order the
 *        workflow reads them. Must be non-empty. All must carry the same
 *        version -- that lockstep is the first thing checked, before the
 *        tag is even looked at.
 * @param {string} input.actionYmlText       the contents of action.yml at this commit
 * @param {string|null} input.changelogText  the contents of CHANGELOG.md at this
 *        commit, or null if it could not be read
 * @param {(name: string, version: string) => string|null} input.publishedVersion
 *        the version the registry reports for name@version, or null if the
 *        lookup did not come back with exactly that version for any reason
 * @returns {{ actionOnly: boolean, scannerVersion: string }}
 * @throws {Error} with a message naming the ref and the condition that failed
 */
export function classifyRelease({
  tagName,
  refDescription,
  packages,
  actionYmlText,
  changelogText,
  publishedVersion,
}) {
  if (!Array.isArray(packages) || packages.length === 0) {
    throw new Error('classifyRelease requires at least one package (packages/*/package.json).');
  }

  // Unchanged in spirit from the two-package check this replaces, and
  // still first: every published package moves in lockstep on purpose, and
  // one of them drifting is not a smaller mistake, it is a silent one.
  // Checked before the tag is even looked at, so a lockstep break reports
  // as a lockstep break rather than as a tag mismatch.
  const version = packages[0].version;
  const mismatched = packages.filter((pkg) => pkg.version !== version);
  if (mismatched.length > 0) {
    const described = packages.map((pkg) => `${pkg.name}@${pkg.version}`).join(', ');
    throw new Error(
      `Version lockstep broken: ${described}, ${refDescription}. Every published package must always carry the same version. Refusing to publish.`
    );
  }

  // workflow_dispatch has no tag at all. The branch guard earlier in the
  // job is what keeps a dispatch run on main; there is nothing here to
  // classify, and a dispatch run is always a package release.
  //
  // The package-release path proper is the line below it: the tag reads
  // "v" + the package version. Neither consults the registry -- a package
  // release publishes a version that is by definition not on the registry
  // yet -- but both check action.yml's default, for the reason in
  // assertPackageReleaseDefault.
  if (tagName === null || tagName === undefined || tagName === '') {
    assertPackageReleaseDefault({ version, actionYmlText, refDescription });
    return { actionOnly: false, scannerVersion: version };
  }

  if (tagName === `v${version}`) {
    assertPackageReleaseDefault({ version, actionYmlText, refDescription });
    return { actionOnly: false, scannerVersion: version };
  }

  // From here on this is an action-only CANDIDATE. It is not an
  // action-only release until all five conditions below hold; a tag that
  // fails any of them is a mistake, and the difference between the two is
  // the whole reason this function exists.
  const tagVersionText = tagName.startsWith('v') ? tagName.slice(1) : null;
  const tagVersion = tagVersionText === null ? null : parseExactSemver(tagVersionText);
  if (tagVersion === null) {
    throw new Error(
      `Tag ${tagName} does not match the package version ${version}, so it could only be an action-only release tag, but it is not "v" plus an exact semver version (no prerelease, no build suffix, no leading zeros -- the same shape action.yml accepts for its version input). Refusing to publish.`
    );
  }

  const packageVersion = parseExactSemver(version);
  if (packageVersion === null) {
    throw new Error(
      `Tag ${tagName} does not match the package version ${version}, and that package version is not exact semver, so the two cannot be ordered against each other. An action-only release requires an exact package version already on the registry. Refusing to publish.`
    );
  }

  if (compareExactSemver(tagVersion, packageVersion) <= 0) {
    throw new Error(
      `Tag ${tagName} is not greater than the package version ${version} (${refDescription}). An action-only release moves the tag forward past the scanner version it ships; a tag at or below the package version is a mistyped or mis-pointed tag. Refusing to publish.`
    );
  }

  // A release nobody wrote down is a release nobody decided to make.
  // Every condition above this one is satisfied by a plain forgotten bump
  // -- packages left at 0.6.0, "v0.7.0" pushed in the belief that they
  // had moved -- because such a tag is exact semver, greater than the
  // package version, backed by published packages, and matched by an
  // action default that never moved either. What separates that stray tag
  // from a real action-only release is that somebody wrote the entry. It
  // is a local check, on the tagged commit's own tree, so it costs
  // nothing and runs before the registry lookup below.
  if (typeof changelogText !== 'string') {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but CHANGELOG.md could not be read at the tagged commit, so its entry could not be checked. Refusing to publish.`
    );
  }
  // A regex built from the tag-derived version string once lived here.
  // The version is exact semver by the time it reaches this point (the
  // parseExactSemver check above already refused anything else), so it
  // was never exploitable, but CodeQL flags the pattern on sight
  // (js/regex-injection, js/incomplete-sanitization) and a "just escape it
  // properly" fix is still a regex built from untrusted input for the next
  // person to get subtly wrong. Splitting into lines and matching a
  // literal prefix needs no escaping at all. The trailing "]" is load
  // bearing: "## [0.6.10]" must not match a heading search for "0.6.1",
  // and closing the bracket into the literal is what stops the shorter
  // version from being read as a prefix of the longer one.
  const headingPrefix = `## [${tagVersionText}]`;
  const hasHeading = changelogText.split('\n').some((line) => line.trim().startsWith(headingPrefix));
  if (!hasHeading) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but CHANGELOG.md at the tagged commit has no "## [${tagVersionText}]" heading. An action-only release is still a release: a tag with no entry is far more likely to be a version bump someone forgot to commit than a deliberate one. Refusing to publish.`
    );
  }

  // The condition that actually carries the "never describes anything
  // unpublished" property. Everything above is shape, ordering and this
  // tree's own files; this is the one that talks to the world.
  for (const pkg of packages) {
    const found = publishedVersion(pkg.name, pkg.version);
    if (found !== pkg.version) {
      throw new Error(
        `Tag ${tagName} looks like an action-only release, but ${pkg.name}@${pkg.version} is not on the npm registry (lookup returned ${found === null || found === undefined ? 'nothing' : `"${found}"`}). An action-only tag must ship a scanner that is already published, or its GitHub Release would describe a version nobody can install. Refusing to publish.`
      );
    }
  }

  const actionDefault = readActionVersionDefault(actionYmlText);
  if (actionDefault !== version) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but action.yml's version input defaults to ${actionDefault} while the packages are at ${version}. An action-only tag ships the scanner that is already published; a moved default means the scanner changed, which is a package release whose packages were never bumped. Refusing to publish.`
    );
  }

  return { actionOnly: true, scannerVersion: version };
}
