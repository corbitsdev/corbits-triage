import { describe, expect, test } from "bun:test";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { isRepoCatchingUp } from "./backlog-status.ts";
import type { HubRun, RunLog } from "./hub-api.ts";

type Source = { logs?: RunLog[]; runs?: HubRun[] };

const catchingUp = (source: Source, repo: string) => isRepoCatchingUp(source.logs ?? [], source.runs ?? [], new Set(), repo);

const backlogRun = (status: HubRun["status"]): HubRun => ({
  id: "run-backlog",
  definitionId: "def-backlog",
  definitionName: "pr-triage-historical",
  tenantId: "tnt",
  address: "run-backlog",
  status,
  createdAt: "2026-03-10T00:00:00.000Z",
  updatedAt: "2026-03-10T00:00:00.000Z",
});

const backlogLog = (repo: string): RunLog => ({
  runId: "run-backlog",
  anchorRunId: "run-backlog",
  events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: stockTriggerMail({ kind: "backlog", repo }) } } }],
});

describe("isRepoCatchingUp", () => {
  test("a live pr-triage-historical run for that repo is catching up", () => {
    const source = {
      runs: [backlogRun("running")],
      logs: [backlogLog("acme/widgets")],
    };
    expect(catchingUp(source, "acme/widgets")).toBe(true);
  });

  test("a running listener parent does not keep a completed child with no pull requests catching up", () => {
    const source = {
      runs: [
        { ...backlogRun("running"), id: "deploy-backlog" },
        { ...backlogRun("stopped"), id: "child-widgets", createdAt: "2026-03-10T00:01:00.000Z" },
      ],
      logs: [
        {
          runId: "child-widgets",
          anchorRunId: "deploy-backlog",
          events: [
            {
              seq: 0,
              type: "RunStarted",
              body: { trigger: { payload: stockTriggerMail({ kind: "backlog", repo: "acme/widgets" }) } },
            },
          ],
        },
      ],
    };
    expect(catchingUp(source, "acme/widgets")).toBe(false);
  });

  test("a log not bound to a backlog run is not a live run", () => {
    const source = {
      logs: [
        {
          runId: "run-other",
          anchorRunId: "run-other",
          events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: stockTriggerMail({ repo: "acme/widgets" }) } } }],
        },
      ],
    };
    expect(catchingUp(source, "acme/widgets")).toBe(false);
  });
});
