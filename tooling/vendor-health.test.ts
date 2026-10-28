import { expect, test } from "bun:test";

import { ModelProviderPlugin } from "../vendor/interchange/packages/types/src/catalog";

test("the operator model provider key passes the vendored catalog boundary", () => {
  expect(ModelProviderPlugin("corbits-system-one")).toBe("corbits-system-one");
});
