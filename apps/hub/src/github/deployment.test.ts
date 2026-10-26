import { describe, expect, test } from "bun:test";
import { pinOf, resolveLiveDeployments, sameSource } from "./deployment.js";

const TENANT_ID = "tnt_acme";
const SOURCE = { kind: "asset", assetId: "ast_triage", package: { format: "source", commitSha: "c0ffee", packageName: "@corbits/pr-triage-workflow" } };
const SPEC = {
  anchorRunId: "run_old",
  deploymentDomain: "acme.test",
  sourceAuthorityPrincipalId: "prn_deployer",
  sourceOfferingIds: ["off_a", "off_b"],
  defaultSourceOfferingId: "off_a",
  deployContent: { systemPrompt: "Triage pull requests." },
  frozenApprovalBundle: { source: SOURCE, entry: "./pr-triage.mjs" },
};

const TARBALL_SOURCE = { kind: "asset", assetId: "ast_corbits", package: { format: "tarball" } };

function closurePinning(...topLevel: { name: string; version: string }[]) {
  const entries = topLevel.map(({ name, version }) => ({
    name,
    version,
    source: { ...TARBALL_SOURCE, package: { format: "tarball", path: `tarballs/${name.slice(1).replace("/", "-")}-${version}.tgz`, integrity: "sha512-AAAA" } },
  }));
  return { schemaVersion: "1", topLevel, entries } as never;
}

function tarballSpec(version: string) {
  return {
    ...SPEC,
    frozenApprovalBundle: {
      source: TARBALL_SOURCE,
      entry: "./pr-triage.mjs",
      closure: closurePinning({ name: "@corbits/pr-triage-workflow", version }),
    },
  };
}

function selectReturning(rows: unknown[]) {
  const chain = {
    from: () => chain,
    innerJoin: () => chain,
    leftJoin: () => chain,
    where: () => chain,
    orderBy: async () => rows,
  };
  return { select: () => chain } as never;
}

describe("deployments", () => {
  test("two deployments run the same source only when asset, commit and entry match", async () => {
    const moved = { ...SPEC, frozenApprovalBundle: { ...SPEC.frozenApprovalBundle, source: { ...SOURCE, package: { ...SOURCE.package, commitSha: "beef" } } } };
    const specs: Record<string, unknown> = { run_a: SPEC, run_b: SPEC, run_moved: moved };
    const launchSpecs = { get: async (anchorRunId: string) => (specs[anchorRunId] ?? null) as never };
    expect(await sameSource(launchSpecs, "run_a", "run_b")).toBe(true);
    expect(await sameSource(launchSpecs, "run_a", "run_moved")).toBe(false);
    expect(await sameSource(launchSpecs, "run_a", "run_missing")).toBe(false);
  });

  test("tarball-sourced deployments with different pins are not the same source", async () => {
    const specs: Record<string, unknown> = { run_a: tarballSpec("0.1.0-a"), run_b: tarballSpec("0.1.0-a"), run_bumped: tarballSpec("0.1.0-b") };
    const launchSpecs = { get: async (anchorRunId: string) => (specs[anchorRunId] ?? null) as never };
    expect(await sameSource(launchSpecs, "run_a", "run_b")).toBe(true);
    expect(await sameSource(launchSpecs, "run_a", "run_bumped")).toBe(false);
  });

  test("a deployment whose cancellation was requested is listed as cancelling", async () => {
    const createdAt = new Date("2026-10-07T12:00:00.000Z");
    const db = selectReturning([
      { runId: "run_new", workflow: "pr-triage", domain: "acme.test", createdAt, cancellationRequestedAt: null },
      { runId: "run_old", workflow: "pr-triage", domain: "acme.test", createdAt, cancellationRequestedAt: createdAt },
    ]);
    expect(await resolveLiveDeployments(db, TENANT_ID, "pr-triage")).toEqual([
      { runId: "run_new", address: "run_new@acme.test", createdAt, cancelling: false, workflow: "pr-triage" },
      { runId: "run_old", address: "run_old@acme.test", createdAt, cancelling: true, workflow: "pr-triage" },
    ]);
  });
});

describe("pinOf", () => {
  test("pins the frozen closure's one top-level package, and refuses a closure without one", () => {
    expect(pinOf(closurePinning({ name: "@corbits/pr-triage-workflow", version: "0.1.0-a" }))).toBe("@corbits/pr-triage-workflow@0.1.0-a");
    expect(() => pinOf(closurePinning())).toThrow("frozen closure has 0 top-level packages, expected one");
  });
});
