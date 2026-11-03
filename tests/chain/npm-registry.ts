// A minimal npm registry that serves @ast-grep/* from the local node_modules
// so chain tests never reach npmjs.org.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import * as tar from "tar";

const ROOT = resolve(import.meta.dir, "../..");
const NAPI_DIR = resolve(ROOT, "packages/triage-workflows/node_modules/@ast-grep/napi");
// Bun's isolated store places @ast-grep/napi and its installed platform package
// (@ast-grep/napi-darwin-arm64, @ast-grep/napi-linux-x64-gnu, etc.) as siblings
// under the resolved @ast-grep scope directory.
const SCOPE_DIR = dirname(realpathSync(NAPI_DIR));

async function packDirectory(dir: string): Promise<Uint8Array> {
  const real = realpathSync(dir);
  const stream = tar.create({ cwd: dirname(real), gzip: true, portable: true }, [basename(real)]);
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk as Uint8Array);
  return new Uint8Array(Buffer.concat(chunks));
}

const cachedTarballs = new Map<string, Promise<Uint8Array>>();

function tarball(dir: string): Promise<Uint8Array> {
  let pending = cachedTarballs.get(dir);
  if (pending === undefined) {
    pending = packDirectory(dir);
    cachedTarballs.set(dir, pending);
  }
  return pending;
}

export type FakeNpmRegistry = { origin: string; stop: () => void };

/**
 * Starts a local HTTP server that answers the requests the hub's closure
 * resolver and the sidecar's tarball loader make when resolving `@ast-grep/napi`
 * and its installed platform binary package from the `npmjs` registry:
 *
 *   GET /@ast-grep/<pkg>          → abbreviated packument with SRI integrity
 *   GET /@ast-grep/<pkg>/-/*.tgz  → the packed tarball
 *
 * Uninstalled platform optional dependencies return 404 so the closure resolver
 * drops those optional subtrees as on any single-platform mirror.
 */
export function fakeNpmRegistry(): FakeNpmRegistry {
  async function serve(req: Request): Promise<Response> {
    const pathname = decodeURIComponent(new URL(req.url).pathname);

    const packumentMatch = /^\/@ast-grep\/([a-z0-9-]+)$/.exec(pathname);
    const subpkg = packumentMatch?.[1];
    if (subpkg !== undefined) {
      const pkgDir = resolve(SCOPE_DIR, subpkg);
      if (!existsSync(pkgDir)) return new Response(null, { status: 404 });
      const pkg = await Bun.file(resolve(pkgDir, "package.json")).json();
      const version = pkg.version as string;
      const tgz = await tarball(pkgDir);
      const origin = req.headers.get("host") ?? "localhost";
      const tarballUrl = `http://${origin}/@ast-grep/${subpkg}/-/${subpkg}-${version}.tgz`;
      return Response.json({
        name: pkg.name,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: pkg.name,
            version,
            dist: {
              tarball: tarballUrl,
              shasum: new Bun.CryptoHasher("sha1").update(tgz).digest("hex"),
              integrity: `sha512-${new Bun.CryptoHasher("sha512").update(tgz).digest("base64")}`,
            },
            ...(pkg.dependencies !== undefined && { dependencies: pkg.dependencies }),
            ...(pkg.optionalDependencies !== undefined && { optionalDependencies: pkg.optionalDependencies }),
            ...(pkg.os !== undefined && { os: pkg.os }),
            ...(pkg.cpu !== undefined && { cpu: pkg.cpu }),
          },
        },
      });
    }

    const tarballMatch = /^\/@ast-grep\/([a-z0-9-]+)\/-\/[a-z0-9.-]+\.tgz$/.exec(pathname);
    const tarballSubpkg = tarballMatch?.[1];
    if (tarballSubpkg !== undefined) {
      const pkgDir = resolve(SCOPE_DIR, tarballSubpkg);
      if (!existsSync(pkgDir)) return new Response(null, { status: 404 });
      const tgz = await tarball(pkgDir);
      return new Response(tgz.buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } });
    }

    return new Response(null, { status: 404 });
  }

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop(): void {
      server.stop(true);
    },
  };
}
