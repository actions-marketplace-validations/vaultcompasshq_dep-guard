// A local npm registry, just enough of the protocol for `npm install -g` and
// `npx --yes` to resolve and install a package.
//
// WHY A SERVER RATHER THAN A STUB. The two routes the action's install
// boundary closes are both decisions REAL npm makes -- which registry it
// reads its configuration from, and whether an already-installed copy
// satisfies a spec. scripts/tests/action-run-script.test.mjs stubs npm, so it
// can prove the action no longer ASKS npm to run from the checkout and cannot
// prove what npm does when it is. That needs the real client, and the real
// client needs something answering HTTP. It must not be npmjs.org: the
// harness has to run offline, and pointing a proven attack at a public
// registry is not a thing to do on purpose.
//
// EVERY REQUEST IS LOGGED, which is the point of the evil instance. "The
// scanner did not come from the attacker's registry" is proven by that
// server's request log being empty, not by reasoning about npm's config
// precedence. A log entry there is the attack connecting.

import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

// npm publishes an integrity string (sha512, base64) and a legacy shasum
// (sha1, hex) alongside every tarball, and verifies both. A packument that
// omitted them, or got them wrong, would fail the install for a reason that
// has nothing to do with what this harness is measuring.
export function distFor(tarball, tarballUrl) {
  return {
    tarball: tarballUrl,
    shasum: createHash('sha1').update(tarball).digest('hex'),
    integrity: `sha512-${createHash('sha512').update(tarball).digest('base64')}`,
  };
}

// The abbreviated packument npm asks for, with one version in it. `versions`
// carries the package's own manifest, because that is where npm reads the
// DEPENDENCIES it then goes on to resolve: a packument that dropped them
// would install a dep-guard with no core and no commander, and the run step
// would fail on a missing module rather than on anything this harness is
// about.
export function buildPackument({ name, version, manifest, tarball, tarballUrl }) {
  return {
    _id: name,
    name,
    'dist-tags': { latest: version },
    versions: {
      [version]: {
        ...manifest,
        name,
        version,
        _id: `${name}@${version}`,
        dist: distFor(tarball, tarballUrl),
      },
    },
  };
}

// `/@scope%2fname` is how npm spells a scoped packument request, and
// `/name/-/name-version.tgz` is the conventional tarball path. Both are
// decoded to a plain key here, so a lookup is one map hit and an unknown path
// is a 404 that shows up in the log rather than a hang.
function routeKey(url) {
  const withoutQuery = url.split('?')[0];
  try {
    return decodeURIComponent(withoutQuery);
  } catch {
    return withoutQuery;
  }
}

export function tarballPathFor(name, version) {
  const bare = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name;
  return `/${name}/-/${bare}-${version}.tgz`;
}

// One package as this registry will serve it: the packument at its name, the
// tarball at the conventional path under it.
//
// The URL has to be absolute and has to name the port this server actually
// got, so the routes are built after listen() rather than from a port chosen
// in advance. An ephemeral port is not a detail: two of these run at once and
// a fixed pair would collide with whatever else is on the machine.
export async function startRegistry({ label, packages }) {
  const routes = new Map();
  const requests = [];

  const server = createServer((req, res) => {
    const key = routeKey(req.url ?? '/');
    requests.push({ method: req.method ?? 'GET', path: key });
    const route = routes.get(key);
    if (!route) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end('{"error":"not found"}');
      return;
    }
    res.writeHead(200, { 'content-type': route.contentType });
    res.end(route.body);
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  // Never a reason on its own for the process to stay alive. Every run closes
  // both servers explicitly before exiting, but a bug that skips that must
  // not turn into a hung harness on top of whatever it already got wrong.
  server.unref();
  const { port } = server.address();
  const origin = `http://127.0.0.1:${port}`;

  for (const entry of packages) {
    const tarballPath = tarballPathFor(entry.name, entry.version);
    const packument = buildPackument({
      name: entry.name,
      version: entry.version,
      manifest: entry.manifest,
      tarball: entry.tarball,
      tarballUrl: `${origin}${tarballPath}`,
    });
    routes.set(`/${entry.name}`, {
      contentType: 'application/json',
      body: Buffer.from(`${JSON.stringify(packument)}\n`),
    });
    routes.set(tarballPath, {
      contentType: 'application/octet-stream',
      body: entry.tarball,
    });
  }

  return {
    label,
    origin,
    port,
    requests,
    // Only the paths, and only the ones that resolved to a package. A request
    // log is what the baseline records, so it has to be stable across runs:
    // the port is in `origin` and changes every time, and npm's header set is
    // not this harness's business.
    paths: () => requests.map((entry) => entry.path),
    // Bounded, and not left to npm's sockets to decide when. `close()` alone
    // only resolves once every connection the OS still has open for this
    // server ends on its own, and a keep-alive socket npm never tore down is
    // exactly the kind of leak that has hung this harness before. A timeout
    // gives up on waiting rather than hanging the whole run over one socket,
    // and closeAllConnections() (present on every Node this package targets)
    // is asked to end them immediately rather than waited on.
    close: () =>
      new Promise((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, 2_000);
        server.close(finish);
        if (typeof server.closeAllConnections === 'function') {
          server.closeAllConnections();
        }
      }),
  };
}
