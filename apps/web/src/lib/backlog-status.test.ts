import { describe, expect, test } from "bun:test";
import { isRepoCatchingUp } from "./backlog-status.ts";
import type { HubRun, RunLog } from "./hub-api.ts";

type Source = { logs?: RunLog[]; runs?: HubRun[] };

const catchingUp = (source: Source, repo: string) => isRepoCatchingUp(source.logs ?? [], source.runs ?? [], repo);

const backlogRun = (status: string): HubRun => ({
  id: "run-backlog",
  definitionId: "def-backlog",
  definitionName: "pr-triage-historical",
  status,
  createdAt: "2026-03-10T00:00:00.000Z",
});

const backlogLog = (repo: string): RunLog => ({
  runId: "run-backlog",
  anchorRunId: "run-backlog",
  events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ kind: "backlog", repo }) } } }],
});

describe("isRepoCatchingUp", () => {
  test("a live pr-triage-historical run for that repo is catching up", () => {
    const source = {
      runs: [backlogRun("running")],
      logs: [backlogLog("acme/widgets")],
    };
    expect(catchingUp(source, "acme/widgets")).toBe(true);
  });

  test("H1: running listener parent does not keep a completed 0-PR child catching up", () => {
    const source = {
      runs: [
        {
          id: "deploy-backlog",
          definitionId: "def-backlog",
          definitionName: "pr-triage-historical",
          status: "running",
          createdAt: "2026-03-10T00:00:00.000Z",
        },
        {
          id: "child-widgets",
          definitionId: "def-backlog",
          definitionName: "pr-triage-historical",
          status: "completed",
          createdAt: "2026-03-10T00:01:00.000Z",
        },
      ],
      logs: [
        {
          runId: "child-widgets",
          anchorRunId: "deploy-backlog",
          events: [
            {
              seq: 0,
              type: "RunStarted",
              body: { trigger: { payload: JSON.stringify({ kind: "backlog", repo: "acme/widgets" }) } },
            },
          ],
        },
      ],
    };
    expect(catchingUp(source, "acme/widgets")).toBe(false);
  });

  test("H4: unbound log without kind:backlog does not invent a live run", () => {
    const source = {
      logs: [
        {
          runId: "run-other",
          anchorRunId: "run-other",
          events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ repo: "acme/widgets" }) } } }],
        },
      ],
    };
    expect(catchingUp(source, "acme/widgets")).toBe(false);
  });
});
