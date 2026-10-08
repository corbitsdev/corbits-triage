import { describe, expect, test } from "bun:test";
import { isRepoCatchingUp } from "./backlog-status.ts";
import type { HubRun, PortalSnapshot, RunLog } from "./hub-api.ts";

const emptySnapshot = (overrides: Partial<PortalSnapshot> = {}): PortalSnapshot => ({
  workspace: { tenantId: "tenant", principalId: "principal", userId: "user" },
  tenantName: "Acme",
  repos: [],
  credentials: [],
  grants: [],
  principals: [],
  roles: [],
  approvals: [],
  runs: [],
  logs: [],
  awaiting: [],
  denied: { repos: false, credentials: false, grants: false, approvals: false, runs: false, logs: false },
  ...overrides,
});

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
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      runs: [backlogRun("running")],
      logs: [backlogLog("acme/widgets")],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(true);
  });

  test("H1: running listener parent does not keep a completed 0-PR child catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
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
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(false);
  });

  test("H4: unbound log without kind:backlog does not invent a live run", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      logs: [
        {
          runId: "run-other",
          anchorRunId: "run-other",
          events: [{ seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ repo: "acme/widgets" }) } } }],
        },
      ],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(false);
  });
});
