// Bundles each workflow package into public/workflows/<name>/ so the portal can push it to the hub.
import { mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { WORKFLOW_PACKAGES } from "../src/lib/workflow-packages.ts";

const WORKFLOW_SRC = resolve(import.meta.dir, "../../../packages/triage-workflows");
const OUT = resolve(import.meta.dir, "../public/workflows");

await rm(OUT, { recursive: true, force: true });
for (const workflow of WORKFLOW_PACKAGES) {
  const dir = join(OUT, workflow.name);
  await mkdir(dir, { recursive: true });
  function bundle(src: string, naming: string) {
    return Bun.build({
      entrypoints: [join(WORKFLOW_SRC, src)],
      outdir: dir,
      naming,
      target: "node",
      format: "esm",
      conditions: ["intx-src"],
      define: { "process.env.TRIAGE_WORKFLOW_PACKAGE_NAME": JSON.stringify(workflow.packageName) },
      throw: true,
    });
  }
  await bundle(workflow.src, workflow.entry.slice(2));
  await bundle("src/directors.ts", "directors.mjs");
  await bundle("src/actions/index.ts", "actions.mjs");
  await Bun.write(join(dir, "package.json"), `${JSON.stringify({
    name: workflow.packageName,
    version: "0.1.0",
    type: "module",
    interchange: { workflow: workflow.entry, directors: "./directors.mjs", actions: "./actions.mjs" },
  }, null, 2)}\n`);
}
console.log(`built ${WORKFLOW_PACKAGES.length} workflow packages into ${OUT}`);
