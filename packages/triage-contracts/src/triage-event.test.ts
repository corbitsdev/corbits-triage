import { describe, expect, test } from "bun:test";
import { triageEventOf, type MailEvent } from "./triage-event.js";

describe("triageEventOf", () => {
  test.each<[MailEvent, ReturnType<typeof triageEventOf>]>([
    [{}, "catch-up"],
    [{ event: "pull_request", action: "synchronize" }, "updated"],
    [{ event: "pull_request", action: "review_requested" }, "updated"],
    [{ event: "pull_request", action: "labeled" }, null],
    [{ event: "check_run", action: "created" }, null],
    [{ event: "check_run", action: "in_progress" }, null],
    [{ event: "check_run", action: "completed" }, "checks"],
    [{ event: "pull_request_review", action: "submitted", review: { state: "approved" } }, "approved"],
    [{ event: "pull_request_review", action: "submitted", review: { state: "CHANGES_REQUESTED" } }, "changes-requested"],
    [{ event: "pull_request_review", action: "submitted", review: { state: "commented" } }, "reviewed"],
  ])("%j maps to %p", (mail, event) => {
    expect(triageEventOf(mail)).toBe(event);
  });
});
