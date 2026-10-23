import { fileURLToPath } from "node:url";
import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Firefox builds default to MV2; both browsers ship the same MV3 extension.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "Corbits Triage",
    description: "Checks the GitHub pull request you are viewing against its repository's .corbits-triage.yml, read-only.",
    permissions: ["storage", ...(browser === "firefox" ? [] : ["sidePanel"])],
    // Reads go through github.com as the person signed in, whose `.diff`, `.patch` and raw files redirect to GitHub's
    // other origins; the REST API serves what the session cannot when a token is saved.
    host_permissions: ["https://github.com/*", "https://patch-diff.githubusercontent.com/*", "https://raw.githubusercontent.com/*", "https://api.github.com/*"],
    action: { default_title: "Corbits Triage" },
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: { id: "triage@corbits.dev", strict_min_version: "128.0" } } } : {}),
  }),
  zip: { name: "corbits-triage" },
  vite: () => ({
    // Interchange's workspace packages export their TypeScript sources under this condition.
    resolve: {
      conditions: ["intx-src", ...defaultClientConditions],
      alias: { "@ast-grep/napi": fileURLToPath(new URL("src/ast-grep.ts", import.meta.url)) },
    },
  }),
});
