import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Firefox builds default to MV2; both browsers ship the same MV3 extension.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "Corbits Triage",
    description: "Checks the GitHub pull request you are viewing against its repository's .corbits-triage.yaml, read-only.",
    permissions: ["storage", ...(browser === "firefox" ? [] : ["sidePanel"])],
    // Every read goes through GitHub's REST API; the content script's github.com match comes from its own entrypoint.
    host_permissions: ["https://api.github.com/*"],
    // A custom decision model endpoint is granted one origin at a time, when the person enters it.
    optional_host_permissions: ["https://*/*", "http://localhost/*", "http://127.0.0.1/*"],
    action: { default_title: "Corbits Triage" },
    ...(browser === "firefox" ? { browser_specific_settings: { gecko: { id: "triage@corbits.dev", strict_min_version: "128.0" } } } : {}),
  }),
  zip: { name: "corbits-triage" },
  vite: () => ({
    // Interchange's workspace packages export their TypeScript sources under this condition.
    resolve: {
      conditions: ["intx-src", ...defaultClientConditions],
    },
  }),
});
