import { describe, expect, test } from "bun:test";
import { decide, type BlockResult, type DecideInput, type Decision } from "./decide.ts";
import type { DecideRule } from "./policy-workflow.ts";

const CLEAN: BlockResult = { outcome: "clean" };
const SKIPPED: BlockResult = { outcome: "skipped" };
const INCOMPLETE: BlockResult = { outcome: "incomplete" };
const MEDIUM: BlockResult = { outcome: "findings", worst: "medium" };

const BASE: DecideInput = {
  triage: "pass",
  events: ["opened"],
  on: ["code-review", "security"],
  outcomes: { "code-review": CLEAN, security: CLEAN },
  author: ["everyone"],
};

const APPROVE_CLEAN: DecideRule = { if: { all: "clean" }, do: "approve" };

describe("decide", () => {
  test.each<[string, readonly DecideRule[], Partial<DecideInput>, Decision]>([
    ["nothing matched flags", [{ if: { triage: "fail" }, do: "request-changes" }], {}, { flag: "no rule matched" }],
    ["first match wins", [{ if: { triage: "pass" }, do: "request-changes" }, APPROVE_CLEAN], {}, { do: "request-changes", rule: 0 }],
    ["skipped blocks don't count toward all clean", [APPROVE_CLEAN], { outcomes: { "code-review": CLEAN, security: SKIPPED } }, { do: "approve", rule: 0 }],
    ["all clean needs a block that ran", [APPROVE_CLEAN], { outcomes: { "code-review": SKIPPED, security: SKIPPED } }, { flag: "no rule matched" }],
    ["an approving rule without triage needs Pass: Unsure", [APPROVE_CLEAN], { triage: "unsure" }, { flag: "no rule matched" }],
    ["an approving rule without triage needs Pass: Fail", [{ if: { event: ["opened"] }, do: "merge" }], { triage: "fail" }, { flag: "no rule matched" }],
    ["an approving rule that names triage matches it", [{ if: { triage: "unsure", all: "clean" }, do: "approve" }], { triage: "unsure" }, { do: "approve", rule: 0 }],
    ["a rule that does not approve matches any verdict", [{ if: { all: "clean" }, do: "request-changes" }], { triage: "fail" }, { do: "request-changes", rule: 0 }],
    ["findings break all clean", [APPROVE_CLEAN], { outcomes: { "code-review": MEDIUM, security: CLEAN } }, { flag: "no rule matched" }],
    ["a skipped block never matches clean", [{ if: { "code-review": "clean" }, do: "approve" }], { outcomes: { "code-review": SKIPPED, security: CLEAN } }, { flag: "no rule matched" }],
    ["findings at the severity match", [{ if: { "code-review": { findings: "medium" } }, do: "request-changes" }], { outcomes: { "code-review": MEDIUM, security: CLEAN } }, { do: "request-changes", rule: 0 }],
    ["findings below the severity don't", [{ if: { "code-review": { findings: "high" } }, do: "request-changes" }], { outcomes: { "code-review": MEDIUM, security: CLEAN } }, { flag: "no rule matched" }],
    ["incomplete never approves or merges", [{ if: { "code-review": "clean" }, do: [{ do: "comment", target: { body: "Thanks!" } }, "merge"] }], { outcomes: { "code-review": CLEAN, security: INCOMPLETE } }, { flag: "a block is incomplete" }],
    ["incomplete still allows other actions", [{ if: { security: "incomplete" }, do: "request-changes" }], { outcomes: { "code-review": CLEAN, security: INCOMPLETE } }, { do: "request-changes", rule: 0 }],
    ["author group must match", [{ if: { author: ["maintainers"] }, do: "approve" }], {}, { flag: "no rule matched" }],
    ["author in the group matches", [{ if: { author: ["maintainers"] }, do: "approve" }], { author: ["everyone", "maintainers"] }, { do: "approve", rule: 0 }],
    ["event must match", [{ if: { event: ["ready"] }, do: "approve" }], {}, { flag: "no rule matched" }],
    ["an outcome counts whether or not the block is on: findings break all clean", [APPROVE_CLEAN], { on: [], outcomes: { "code-review": { outcome: "findings", worst: "critical" } } }, { flag: "no rule matched" }],
    ["an outcome counts whether or not the block is on: incomplete holds approve", [{ if: { triage: "pass" }, do: "approve" }], { on: [], outcomes: { "code-review": INCOMPLETE } }, { flag: "a block is incomplete" }],
    ["a block that is on with no outcome is incomplete, so a rule's approve is held", [{ if: { triage: "pass" }, do: "approve" }], { outcomes: { "code-review": CLEAN } }, { flag: "a block is incomplete" }],
    ["a block that is on with no outcome is incomplete, so all clean can't approve over it", [APPROVE_CLEAN], { outcomes: { "code-review": CLEAN } }, { flag: "no rule matched" }],
    ["a rule on groups flags when the author's are not known", [{ if: { author: ["maintainers"] }, do: "approve" }], { author: undefined }, { flag: "it is not known which groups the author is in" }],
  ])("%s", (_, rules, input, expected) => {
    expect(decide(rules, { ...BASE, ...input })).toEqual(expected);
  });
});
