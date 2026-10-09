import { describe, expect, test } from "bun:test";
import { cancelsSuperseded } from "./workflow-deploy.ts";

describe("cancelsSuperseded", () => {
  test("pr-triage's superseded deployments are cancelled only right after a deploy; pr-triage-historical's on every converge", () => {
    expect([cancelsSuperseded("pr-triage", true), cancelsSuperseded("pr-triage", false)]).toEqual([true, false]);
    expect([cancelsSuperseded("pr-triage-historical", true), cancelsSuperseded("pr-triage-historical", false)]).toEqual([true, true]);
  });
});
