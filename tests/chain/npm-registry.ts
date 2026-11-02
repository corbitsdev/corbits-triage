// A minimal npm registry that serves @ast-grep/napi from the local node_modules
// so chain tests never reach npmjs.org.
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const NAPI_DIR = resolve(ROOT, "packages/triage-workflows/node_modules/@ast-grep/napi");

/** Packs a directory into a gzipped tarball with an npm-style `package/` prefix. */
async function packDirectory(dir: string): Promise<Uint8Array> {
  const proc = Bun.spawn(["tar", "czf", "-", "--cd", dir, "-s", "/^\\./package/", "."], { stdout: "pipe", stderr: "pipe" });
  const chunks: Uint8Array[] = [];
  for await (const chunk of proc.stdout) chunks.push(chunk);
  const code = await proc.exited;
  if (code !== 0) throw new Error(`tar exited ${code}`);
  return new Uint8Array(Buffer.concat(chunks));
}

let cachedTarball: Uint8Array | undefined;

async function tarball(): Promise<Uint8Array> {
  if (cachedTarball === undefined) cachedTarball = await packDirectory(NAPI_DIR);
  return cachedTarball;
}

export type FakeNpmRegistry = { origin: string; stop: () => void };

/**
 * Starts a local HTTP server that answers the two requests the hub's session
 * service makes when resolving `@ast-grep/napi` from the npmjs registry:
 *
 *   GET /@ast-grep/napi          → abbreviated package metadata
 *   GET /@ast-grep/napi/-/*.tgz  → the tarball
 *
 * Structured like `fakeGithub` in github.ts.
 */
export function fakeNpmRegistry(): FakeNpmRegistry {
  async function serve(req: Request): Promise<Response> {
    const { pathname } = new URL(req.url);

    if (pathname === "/@ast-grep/napi" || pathname === "/@ast-grep%2fnapi") {
      const pkg = await Bun.file(resolve(NAPI_DIR, "package.json")).json();
      const version = pkg.version as string;
      const tgz = await tarball();
      // The abbreviated packument the npm client and the hub's registry
      // resolver need: one version entry whose dist.tarball points back
      // to this server.
      const origin = req.headers.get("host") ?? "localhost";
      const protocol = "http";
      const tarballUrl = `${protocol}://${origin}/@ast-grep/napi/-/napi-${version}.tgz`;
      const metadata = {
        name: "@ast-grep/napi",
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            name: pkg.name,
            version,
            dist: {
              tarball: tarballUrl,
              shasum: new Bun.CryptoHasher("sha1").update(tgz).digest("hex"),
            },
            optionalDependencies: pkg.optionalDependencies,
          },
        },
      };
      return Response.json(metadata);
    }

    if (pathname.startsWith("/@ast-grep/napi/-/") && pathname.endsWith(".tgz")) {
      const tgz = await tarball();
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
