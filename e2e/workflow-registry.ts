// Packs the workflows with their native modules from npm, installs them from the registry alone as a deploy
// does, and runs one ast-grep match through the installed pr-triage workflow.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { NPM_NATIVE, packWorkflows, SIDECAR_PLATFORMS } from "../apps/web/scripts/build-workflows.ts";
import { installWorkflows, loadUnderNode } from "../apps/web/scripts/install-from-registry.ts";

const MATCH = `const { Lang, parse } = await import("@ast-grep/napi"); if (!parse(Lang.TypeScript, "eval(code)").root().find("eval($A)")) throw new Error("no match");`;

const root = await mkdtemp(path.join(tmpdir(), "workflow-registry-"));
try {
  // The host's binary too, so the installed workflow loads here as well as on a sidecar.
  const platforms = [...SIDECAR_PLATFORMS, { os: process.platform, cpu: process.arch, libc: "glibc" }];
  const index = await packWorkflows(path.join(root, "registry/tarballs"), { ...NPM_NATIVE, platforms });
  for (const packageDir of await installWorkflows(root, index)) {
    const manifest = JSON.parse(await readFile(path.join(packageDir, "package.json"), "utf8"));
    const extra = manifest.dependencies["@ast-grep/napi"] ? [MATCH] : [];
    for (const { program, stderr, code } of await loadUnderNode(packageDir, extra)) {
      if (code === 0 && stderr === "") continue;
      process.exitCode = 1;
      console.error(`${packageDir}: ${program}\n${stderr}`);
    }
  }
  if (process.exitCode !== 1) console.log(`installed and loaded every workflow from a registry of ${index.length} tarballs`);
} finally {
  await rm(root, { recursive: true, force: true });
}
