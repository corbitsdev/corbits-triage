import { defaultClientConditions } from "vite";
import { defineConfig } from "wxt";

export default defineConfig({
  modules: ["@wxt-dev/module-react"],
  // Firefox builds default to MV2; both browsers ship the same MV3 extension.
  manifestVersion: 3,
  manifest: ({ browser }) => ({
    name: "Corbits Triage",
    description: "Scores the GitHub pull request in the current tab, lists its checks and drafts the comments you post yourself.",
    permissions: ["storage", ...(browser === "firefox" ? [] : ["sidePanel"])],
    // A pull request's .diff redirects from github.com to patch-diff.githubusercontent.com, a repository's files to raw.githubusercontent.com.
    host_permissions: ["https://github.com/*", "https://patch-diff.githubusercontent.com/*", "https://raw.githubusercontent.com/*", "https://api.github.com/*"],
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
