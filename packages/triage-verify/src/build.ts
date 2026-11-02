import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PACKAGE_DIR = join(import.meta.dir, "..");
const SOURCE_SHEBANG = "#!/usr/bin/env -S bun --conditions=intx-src\n";
const REPO_ROOT = join(PACKAGE_DIR, "../..");

const FORBIDDEN = [
  'from "@corbits/',
  "from '@corbits/",
  'require("@corbits/',
  "require('@corbits/",
  'from "@intx/',
  "from '@intx/",
  'require("@intx/',
  "require('@intx/",
  "workspace:",
];

const PUBLISH_MANIFEST = `{
  "name": "@corbits/triage-verify",
  "version": "0.1.0",
  "license": "SEE LICENSE IN LICENSE.md",
  "type": "module",
  "bin": {
    "triage-verify": "./cli.js"
  },
  "files": ["cli.js", "README.md", "LICENSE.md", "GPL-2.0.txt", "GPLv2-AI-Exception.md"]
}
`;

export async function build(outDir: string): Promise<void> {
  const result = await Bun.build({
    entrypoints: [join(PACKAGE_DIR, "src/cli.ts")],
    outdir: outDir,
    target: "node",
    packages: "bundle",
    sourcemap: "none",
    banner: "#!/usr/bin/env node",
    format: "esm",
  });
  if (!result.success) {
    const detail = result.logs.map((log) => log.message).join("\n");
    throw new Error(detail.length > 0 ? detail : "Bun.build failed");
  }
  const cliPath = join(outDir, "cli.js");
  const bundledRaw = readFileSync(cliPath, "utf8");
  const bundled = bundledRaw.startsWith(SOURCE_SHEBANG) ? bundledRaw.slice(SOURCE_SHEBANG.length) : bundledRaw;
  if (bundled !== bundledRaw) writeFileSync(cliPath, bundled);
  const hit = FORBIDDEN.find((item) => bundled.includes(item));
  if (hit !== undefined) throw new Error(`bundle contains a live specifier: ${hit}`);
  writeFileSync(join(outDir, "package.json"), PUBLISH_MANIFEST);
  copyFileSync(join(PACKAGE_DIR, "README.md"), join(outDir, "README.md"));
  copyFileSync(join(REPO_ROOT, "LICENSE.md"), join(outDir, "LICENSE.md"));
  copyFileSync(join(REPO_ROOT, "GPL-2.0.txt"), join(outDir, "GPL-2.0.txt"));
  copyFileSync(join(REPO_ROOT, "GPLv2-AI-Exception.md"), join(outDir, "GPLv2-AI-Exception.md"));
}

if (import.meta.main) {
  await build(join(PACKAGE_DIR, "dist"));
}
