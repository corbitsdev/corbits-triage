import { describe, expect, test } from "bun:test";
import { stockTriggerMail } from "@corbits/triage-contracts";
import { catchingUpRepos, isRepoCatchingUp } from "./backlog-status.ts";
import type { HubRun, RunLog } from "./hub-api.ts";

type Source = { logs?: RunLog[]; runs?: HubRun[] };

const catchingUp = (source: Source, repo: string) => isRepoCatchingUp(source.logs ?? [], source.runs ?? [], [], { name: repo });

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

const backlogLog = (repo: string, repoSource?: string, runId = "run-backlog"): RunLog => ({
  runId,
  anchorRunId: runId,
  events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: stockTriggerMail({ kind: "backlog", repo, ...(repoSource !== undefined && { repoSource }) }) } } }],
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

  test("a repository is caught up only on the host whose pr-triage ran, though the other host has the same name", () => {
    const runs = [backlogRun("running"), { ...backlogRun("running"), id: "run-bitbucket" }];
    const logs = [backlogLog("acme/widgets"), backlogLog("acme/widgets", "bitbucket-datacenter", "run-bitbucket")];
    expect(catchingUpRepos(logs, runs, [{ name: "acme/widgets", source: "github" }])).toEqual([{ name: "acme/widgets", source: "bitbucket-datacenter" }]);
  });
});
