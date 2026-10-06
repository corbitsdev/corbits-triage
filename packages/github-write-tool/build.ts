await Bun.build({
  entrypoints: ["../github-tool/src/write-bundle.ts"],
  outdir: "./dist",
  naming: "sidecar-bundle.js",
  target: "node",
  format: "esm",
  conditions: ["intx-src"],
  throw: true,
});
