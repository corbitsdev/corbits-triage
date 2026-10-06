// SPDX-License-Identifier: GPL-2.0-only
import { expect, test } from "bun:test";
import { resolve } from "node:path";

import { ModelProviderPlugin } from "../vendor/interchange/packages/types/src/catalog";
import { loadWorkflowDirectorRegistryFromClosure } from "../vendor/interchange/packages/workflow-host/src/workflow-definition-loader";

import { workflow } from "../packages/triage-workflows/src/pr-triage";

test("the operator model provider key passes the vendored catalog boundary", () => {
  expect(ModelProviderPlugin("corbits-system-one")).toBe("corbits-system-one");
});

test("the retained PR #193 loader resolves the repository custom director", async () => {
  const registry = await loadWorkflowDirectorRegistryFromClosure({
    packageDir: resolve(import.meta.dirname, "../packages/triage-workflows"),
    definition: workflow,
  });

  const factory = registry.resolve({
    id: "@corbits/triage-workflows/triage",
    config: { role: "facts" },
  });
  expect(factory.id).toBe("@corbits/triage-workflows/triage");
});
