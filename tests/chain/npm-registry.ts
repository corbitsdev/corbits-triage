// Serves installed @ast-grep/* packages from local node_modules so chain tests never reach npmjs.org.
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import * as tar from "tar";

// Bun's isolated store places @ast-grep/napi and its installed platform binary sibling under one scope directory.
const SCOPE_DIR = dirname(realpathSync(resolve(import.meta.dir, "../../packages/triage-workflows/node_modules/@ast-grep/napi")));
const cachedTarballs = new Map<string, Promise<Uint8Array>>();

async function packDirectory(dir: string): Promise<Uint8Array> {
  const real = realpathSync(dir);
  const chunks: Uint8Array[] = [];
  for await (const chunk of tar.create({ cwd: dirname(real), gzip: true, portable: true }, [basename(real)])) {
    chunks.push(chunk as Uint8Array);
  }
  return new Uint8Array(Buffer.concat(chunks));
}

function tarball(dir: string): Promise<Uint8Array> {
  let pending = cachedTarballs.get(dir);
  if (pending === undefined) {
    pending = packDirectory(dir);
    cachedTarballs.set(dir, pending);
  }
  return pending;
}

export type FakeNpmRegistry = { origin: string; stop: () => void };

export function fakeNpmRegistry(): FakeNpmRegistry {
  async function serve(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const pathname = decodeURIComponent(url.pathname);
    const match = /^\/@ast-grep\/([a-z0-9-]+)(?:\/-\/[a-z0-9.-]+\.tgz)?$/.exec(pathname);
    const subpkg = match?.[1];
    if (subpkg === undefined) return new Response(null, { status: 404 });
    const pkgDir = resolve(SCOPE_DIR, subpkg);
    // Uninstalled platform optional dependencies return 404 so the closure resolver drops those subtrees.
    if (!existsSync(pkgDir)) return new Response(null, { status: 404 });
    const tgz = await tarball(pkgDir);
    if (pathname.endsWith(".tgz")) {
      return new Response(tgz.buffer as ArrayBuffer, { headers: { "content-type": "application/octet-stream" } });
    }
    const pkg = await Bun.file(resolve(pkgDir, "package.json")).json();
    const version = pkg.version as string;
    return Response.json({
      name: pkg.name,
      "dist-tags": { latest: version },
      versions: {
        [version]: {
          name: pkg.name,
          version,
          dist: {
            tarball: `${url.origin}/@ast-grep/${subpkg}/-/${subpkg}-${version}.tgz`,
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

  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: serve });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    stop(): void {
      server.stop(true);
    },
  };
}
