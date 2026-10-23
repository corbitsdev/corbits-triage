// Installs oxlint's standalone native binary at the lockfile's version for the code review's lint step, so the step
// never starts bun or node, which would load config from the folder they run in.
import { createHash } from "node:crypto";
import { chmod, copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import * as tar from "tar";
import oxlint from "../node_modules/oxlint/package.json" with { type: "json" };

const VERSION = "1.87.0";
const TARGETS: Record<string, { name: string; sha256: string }> = {
  x64: { name: "x86_64-unknown-linux-gnu", sha256: "97a075ac82cd6131641101016f79142ac6765ba79a5a582864450e30d192a425" },
  arm64: { name: "aarch64-unknown-linux-gnu", sha256: "2226c5ac023135808a391a5f746666ca0fa398f05252b9007c329e4b62ae03c0" },
};

const [destination] = process.argv.slice(2);
if (destination === undefined) throw new Error("usage: bun tooling/install-oxlint.ts <destination>");
if (oxlint.version !== VERSION) throw new Error(`the lockfile pins oxlint ${oxlint.version}; update VERSION and the digests here`);
const target = TARGETS[process.arch];
if (target === undefined) throw new Error(`no oxlint binary pinned for ${process.arch}`);

const asset = `oxlint-${target.name}`;
const response = await fetch(`https://github.com/oxc-project/oxc/releases/download/oxlint_v${VERSION}/${asset}.tar.gz`);
if (!response.ok) throw new Error(`oxlint download failed: ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
const digest = createHash("sha256").update(archive).digest("hex");
if (digest !== target.sha256) throw new Error(`oxlint download digest ${digest} does not match the pinned ${target.sha256}`);

const dir = await mkdtemp(path.join(tmpdir(), "oxlint-"));
try {
  const file = path.join(dir, "oxlint.tar.gz");
  await Bun.write(file, archive);
  await tar.extract({ file, cwd: dir });
  await copyFile(path.join(dir, asset), destination);
  await chmod(destination, 0o755);
} finally {
  await rm(dir, { recursive: true, force: true });
}
