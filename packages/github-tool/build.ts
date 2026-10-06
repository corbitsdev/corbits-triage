await Bun.build({
  entrypoints: ["./src/read-bundle.ts"],
  outdir: "./dist",
  naming: "sidecar-bundle.js",
  target: "node",
  format: "esm",
  conditions: ["intx-src"],
  throw: true,
});
