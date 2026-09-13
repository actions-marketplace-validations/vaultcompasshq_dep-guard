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
// The release workflow's version assertion knew only one shape, "the tag
// must read v plus the package version", so that tag push went red before
// install, build or publish. Nothing was published, which was right, but
// the tag got no Release page and every future action-only tag would have
// failed the same way.
//
// The property the old assertion bought has to survive admitting the
// second shape: a mistyped or mis-pointed tag must never publish anything,
// and must never describe an unpublished version in a Release. An
// action-only tag is therefore not "any tag that is not an exact match" --
// it is a tag that clears all four of the conditions below, each of which
// closes off one way a typo could get through:
//
//   a. exact semver, no prerelease or build suffix, no leading zeros --
//      the same shape action.yml validates its own version input against,
//      so a tag this repo blesses is a tag the action could be pinned to;
//   b. strictly greater than the package version by NUMERIC semver
//      ordering, so a tag onto an older line ("v0.9.0" while the packages
//      are at 0.10.0, which string comparison reads as a forward move) is
//      a mistake rather than a release;
//   c. both packages ALREADY on the registry at exactly the package
//      version, which is what makes "describes nothing unpublished"
//      true rather than merely likely;
//   d. action.yml's version default equal to the package version, because
//      an action-only tag ships the scanner that is already published --
//      if the default moved, the scanner changed and this is a package
//      release whose packages were never bumped.
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
 * Deliberately not a "first default: after version:" grep. That input's
 * description is a long block scalar that names example versions and the
 * word "default" in prose, so a looser reader would compare the tag
 * against a number nobody ships. The keys of an input sit at exactly four
 * spaces and the block scalar's content sits deeper, so anchoring on the
 * indentation is what separates the two -- and only the lines between
 * this input's own two-space key and the next one are considered at all.
 *
 * A real YAML parser would be better, but this file runs in the release
 * job BEFORE `pnpm install` (on purpose -- the whole point is to catch a
 * tag-time mistake before a fifteen-minute corpus walk), so it gets node
 * builtins and nothing else.
 */
export function readActionVersionDefault(actionYmlText) {
  const lines = String(actionYmlText).split('\n');
  const start = lines.findIndex((line) => /^ {2}version:\s*$/.test(line));
  if (start === -1) {
    throw new Error(
      'action.yml has no `version:` input at the expected indentation, so the scanner version this action tag ships could not be read.'
    );
  }

  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i];
    // The next key at this input's own level, or any key shallower than
    // it, ends this input's block.
    if (/^ {0,2}\S/.test(line) && line.trim() !== '') {
      break;
    }
    const match = /^ {4}default:\s*(.*)$/.exec(line);
    if (match !== null) {
      return match[1].trim().replace(/^['"]|['"]$/g, '');
    }
  }

  throw new Error(
    "action.yml's `version:` input has no `default:` at the expected indentation, so the scanner version this action tag ships could not be read."
  );
}

/**
 * @param {object} input
 * @param {string|null} input.tagName        the pushed tag, or null on workflow_dispatch
 * @param {string} input.refDescription      how to name this ref in an error message
 * @param {string} input.coreName            the core package's npm name
 * @param {string} input.coreVersion         packages/core's version
 * @param {string} input.cliName             the cli package's npm name
 * @param {string} input.cliVersion          packages/cli's version
 * @param {string} input.actionYmlText       the contents of action.yml at this commit
 * @param {(name: string, version: string) => string|null} input.publishedVersion
 *        the version the registry reports for name@version, or null if the
 *        lookup did not come back with exactly that version for any reason
 * @returns {{ actionOnly: boolean, scannerVersion: string }}
 * @throws {Error} with a message naming the ref and the condition that failed
 */
export function classifyRelease({
  tagName,
  refDescription,
  coreName,
  coreVersion,
  cliName,
  cliVersion,
  actionYmlText,
  publishedVersion,
}) {
  // Unchanged from the original assertion, and still first: the two
  // packages are published in lockstep on purpose, and a cli release
  // without a matching core bump is not a smaller mistake, it is a silent
  // one. Checked before the tag is even looked at, so a lockstep break
  // reports as a lockstep break rather than as a tag mismatch.
  if (coreVersion !== cliVersion) {
    throw new Error(
      `Version lockstep broken: packages/core is at ${coreVersion}, packages/cli is at ${cliVersion}, ${refDescription}. core and cli must always carry the same version. Refusing to publish.`
    );
  }

  // workflow_dispatch has no tag at all. The branch guard earlier in the
  // job is what keeps a dispatch run on main; there is nothing here to
  // classify, and a dispatch run is always a package release.
  if (tagName === null || tagName === undefined || tagName === '') {
    return { actionOnly: false, scannerVersion: coreVersion };
  }

  // The package-release path, byte for byte what it always was: the tag
  // reads "v" + the package version. Nothing below this line runs for it,
  // the registry included -- a package release publishes a version that
  // is by definition not on the registry yet.
  if (tagName === `v${coreVersion}`) {
    return { actionOnly: false, scannerVersion: coreVersion };
  }

  // From here on this is an action-only CANDIDATE. It is not an
  // action-only release until all four conditions below hold; a tag that
  // fails any of them is a mistake, and the difference between the two is
  // the whole reason this function exists.
  const tagVersionText = tagName.startsWith('v') ? tagName.slice(1) : null;
  const tagVersion = tagVersionText === null ? null : parseExactSemver(tagVersionText);
  if (tagVersion === null) {
    throw new Error(
      `Tag ${tagName} does not match the package version ${coreVersion}, so it could only be an action-only release tag, but it is not "v" plus an exact semver version (no prerelease, no build suffix, no leading zeros -- the same shape action.yml accepts for its version input). Refusing to publish.`
    );
  }

  const packageVersion = parseExactSemver(coreVersion);
  if (packageVersion === null) {
    throw new Error(
      `Tag ${tagName} does not match the package version ${coreVersion}, and that package version is not exact semver, so the two cannot be ordered against each other. An action-only release requires an exact package version already on the registry. Refusing to publish.`
    );
  }

  if (compareExactSemver(tagVersion, packageVersion) <= 0) {
    throw new Error(
      `Tag ${tagName} is not greater than the package version ${coreVersion} (${refDescription}). An action-only release moves the tag forward past the scanner version it ships; a tag at or below the package version is a mistyped or mis-pointed tag. Refusing to publish.`
    );
  }

  // The condition that actually carries the "never describes anything
  // unpublished" property. Everything above is shape and ordering; this is
  // the one that talks to the world.
  for (const [name, version] of [
    [coreName, coreVersion],
    [cliName, cliVersion],
  ]) {
    const found = publishedVersion(name, version);
    if (found !== version) {
      throw new Error(
        `Tag ${tagName} looks like an action-only release, but ${name}@${version} is not on the npm registry (lookup returned ${found === null || found === undefined ? 'nothing' : `"${found}"`}). An action-only tag must ship a scanner that is already published, or its GitHub Release would describe a version nobody can install. Refusing to publish.`
      );
    }
  }

  const actionDefault = readActionVersionDefault(actionYmlText);
  if (actionDefault !== coreVersion) {
    throw new Error(
      `Tag ${tagName} looks like an action-only release, but action.yml's version input defaults to ${actionDefault} while the packages are at ${coreVersion}. An action-only tag ships the scanner that is already published; a moved default means the scanner changed, which is a package release whose packages were never bumped. Refusing to publish.`
    );
  }

  return { actionOnly: true, scannerVersion: coreVersion };
}
