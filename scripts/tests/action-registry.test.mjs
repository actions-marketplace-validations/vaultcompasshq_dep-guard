// The abbreviated packument shape bench/action-install.mjs hands real npm.
// No server here: startRegistry is exercised end to end by the harness
// itself, and a unit test that opened an HTTP server would risk exactly the
// leaked-listener hang this suite has to stay free of. What is pure -- the
// dist block's digests and the packument's own shape -- is what is tested
// here.

import { describe, expect, it } from '@jest/globals';

import { buildPackument, distFor, tarballPathFor } from '../../bench/lib/action-registry.mjs';

describe('distFor', () => {
  it('computes both digests npm publishes alongside a tarball', () => {
    const tarball = Buffer.from('some tarball bytes');
    const dist = distFor(tarball, 'http://127.0.0.1:1/x.tgz');
    expect(dist.tarball).toBe('http://127.0.0.1:1/x.tgz');
    expect(dist.shasum).toMatch(/^[0-9a-f]{40}$/);
    expect(dist.integrity).toMatch(/^sha512-/);
  });

  it('changes both digests when the bytes differ', () => {
    const a = distFor(Buffer.from('one'), 'http://127.0.0.1:1/x.tgz');
    const b = distFor(Buffer.from('two'), 'http://127.0.0.1:1/x.tgz');
    expect(a.shasum).not.toBe(b.shasum);
    expect(a.integrity).not.toBe(b.integrity);
  });
});

describe('tarballPathFor', () => {
  it('spells a scoped package the way npm serves one, name kept, scope dropped from the filename', () => {
    expect(tarballPathFor('@vaultcompass/dep-guard', '0.6.0')).toBe(
      '/@vaultcompass/dep-guard/-/dep-guard-0.6.0.tgz'
    );
  });

  it('spells an unscoped package', () => {
    expect(tarballPathFor('commander', '12.1.0')).toBe('/commander/-/commander-12.1.0.tgz');
  });
});

describe('buildPackument', () => {
  it('names the version under dist-tags and versions, carrying the manifest and dist info', () => {
    const tarball = Buffer.from('tgz-bytes');
    const packument = buildPackument({
      name: '@vaultcompass/dep-guard',
      version: '0.6.0',
      manifest: {
        name: '@vaultcompass/dep-guard',
        version: '0.6.0',
        dependencies: { commander: '12.1.0' },
      },
      tarball,
      tarballUrl: 'http://127.0.0.1:1/x.tgz',
    });

    expect(packument.name).toBe('@vaultcompass/dep-guard');
    expect(packument['dist-tags']).toEqual({ latest: '0.6.0' });

    const versionEntry = packument.versions['0.6.0'];
    // The dependency closure is what makes an install of this packument
    // resolve core and commander too; dropping it here would install a
    // dep-guard the run step then fails on with a missing module, for a
    // reason this harness is not about.
    expect(versionEntry.dependencies).toEqual({ commander: '12.1.0' });
    expect(versionEntry.name).toBe('@vaultcompass/dep-guard');
    expect(versionEntry.version).toBe('0.6.0');
    expect(versionEntry.dist).toEqual(distFor(tarball, 'http://127.0.0.1:1/x.tgz'));
  });

  it('only ever carries the one version it was given', () => {
    const packument = buildPackument({
      name: 'commander',
      version: '12.1.0',
      manifest: { name: 'commander', version: '12.1.0' },
      tarball: Buffer.from('x'),
      tarballUrl: 'http://127.0.0.1:1/commander.tgz',
    });
    expect(Object.keys(packument.versions)).toEqual(['12.1.0']);
  });
});
