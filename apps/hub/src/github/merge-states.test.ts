import { expect, test } from "bun:test";
import { MAX_MERGE_STATES } from "@corbits/triage-contracts";
import { createMergeStates } from "./merge-states.js";

// Refused before the workspace is read, so no database is needed.
const handle = createMergeStates({ githubApiOrigin: "https://api.github.test", log() {} } as unknown as Parameters<typeof createMergeStates>[0]);

async function refusal(numbers: string) {
  const res = await handle(new Request(`http://hub.test/merge-states?repo=acme/widgets&numbers=${numbers}`), { tenantId: "t", principalId: "p" });
  return { status: res.status, body: await res.json() };
}

test("asks about at most 100 pull requests, each a number GraphQL can carry", async () => {
  const many = Array.from({ length: MAX_MERGE_STATES + 1 }, (_, i) => i + 1).join(",");
  expect(await refusal(many)).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "Ask about at most 100 pull requests at once." } } });
  expect(await refusal("1,2147483648")).toEqual({ status: 400, body: { error: { code: "invalid_request", message: "A pull request number is at most 2147483647." } } });
});
