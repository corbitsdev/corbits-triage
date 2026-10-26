// The listener entries read the release the portal publishes beside them; the source tree holds none, so a fixture
// stands in. Imported before any entry, so the entries read it.
import { mock } from "bun:test";

const RELEASE = {
  workflow: { assetId: "ast_fixture_manager", commitSha: "0".repeat(40), packageName: "@corbits/triage-manager", entry: "./triage-manager-github.mjs" },
  offerings: { ids: ["off_fixture"], defaultId: "off_fixture" },
};

mock.module(new URL("../packages/triage-manager/src/release.json", import.meta.url).pathname, () => ({ default: { github: { manager: RELEASE }, "bitbucket-datacenter": { manager: RELEASE } } }));
