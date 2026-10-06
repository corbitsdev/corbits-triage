import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DEFAULT_GITHUB_API_ORIGIN } from "./github/github-app-credential-adapter.js";

const GITHUB_APP_CREDENTIAL_PROVIDER = "corbits-github-app-credential";

const SYSTEM_ONE_ADAPTER_MANIFEST = [
  {
    provider: "corbits-system-one",
    specifier: "@corbits/system-one",
    export: "createSystemOneAdapterFactory",
  },
  {
    provider: GITHUB_APP_CREDENTIAL_PROVIDER,
    specifier: pathToFileURL(resolve(
      import.meta.dirname,
      "github/github-app-adapter-module.ts",
    )).href,
    export: "installGithubAppCredentialAdapter",
  },
] as const;

/**
 * Workflow children start with a fresh env, so a non-default GitHub origin
 * (e.g. a local emulator) is baked into a generated entry module under
 * `dataDir` instead of being read from the environment.
 */
export function buildSidecarAdapterManifest(dataDir: string, githubApiOrigin: string): string {
  if (githubApiOrigin === DEFAULT_GITHUB_API_ORIGIN) return JSON.stringify(SYSTEM_ONE_ADAPTER_MANIFEST);
  const adapter = pathToFileURL(resolve(import.meta.dirname, "github/github-app-adapter.ts")).href;
  const entry = resolve(dataDir, "github-app-adapter-entry.ts");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(entry, [
    `import { installGithubAppFetch } from ${JSON.stringify(adapter)};`,
    `installGithubAppFetch(${JSON.stringify(githubApiOrigin)});`,
    `export { installGithubAppCredentialAdapter } from ${JSON.stringify(adapter)};`,
    "",
  ].join("\n"));
  const entrySpecifier = pathToFileURL(entry).href;
  return JSON.stringify(SYSTEM_ONE_ADAPTER_MANIFEST.map((row) =>
    row.provider === GITHUB_APP_CREDENTIAL_PROVIDER ? { ...row, specifier: entrySpecifier } : row));
}
