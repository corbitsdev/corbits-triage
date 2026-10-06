// SPDX-License-Identifier: GPL-2.0-only
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

const pendingSync = { "acme/widgets": { status: "pending" as const, operationId: "op-1" } };

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

const classifiedLog: RunLog = {
  runId: "run-pr",
  anchorRunId: "run-pr",
  events: [
    { seq: 0, type: "RunStarted", body: { trigger: { payload: JSON.stringify({ kind: "pr", repo: "acme/widgets", prNumber: 8 }) } } },
    {
      seq: 1,
      type: "StepCompleted",
      body: {
        stepId: "render",
        output: { ref: `inline:${JSON.stringify({ repo: "acme/widgets", number: 8, state: "ready-monitoring" })}` },
      },
    },
  ],
};

describe("isRepoCatchingUp", () => {
  test("pending with no PRs and no completed backlog run is catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: pendingSync },
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(true);
  });

  test("pending plus a completed backlog run for that repo is not catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: pendingSync },
      runs: [backlogRun("completed")],
      logs: [backlogLog("acme/widgets")],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(false);
  });

  test("no backlogSync plus a live pr-triage-historical run for that repo is catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      runs: [backlogRun("running")],
      logs: [backlogLog("acme/widgets")],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(true);
  });

  test("pending plus a projected PR for that repo is not catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: pendingSync },
      logs: [classifiedLog],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(false);
  });

  test("failed backlog sync is not catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: { "acme/widgets": { status: "failed", operationId: "op-1", error: "timeout" } } },
      runs: [backlogRun("running")],
      logs: [backlogLog("acme/widgets")],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(false);
  });

  test("H1: running listener parent does not keep a completed 0-PR child catching up", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: pendingSync },
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

  test("H2: missing child run with only a completed parent is still catching up when pending", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: pendingSync },
      runs: [
        {
          id: "deploy-backlog",
          definitionId: "def-backlog",
          definitionName: "pr-triage-historical",
          status: "completed",
          createdAt: "2026-03-10T00:00:00.000Z",
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
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(true);
  });

  test("H3: stringify repo mention on a completed run without kind:backlog is not a completed scan", () => {
    const snapshot = emptySnapshot({
      repos: [{ name: "acme/widgets", connected: true }],
      config: { backlogSync: pendingSync },
      runs: [backlogRun("completed")],
      logs: [
        {
          runId: "run-backlog",
          anchorRunId: "run-backlog",
          events: [
            {
              seq: 0,
              type: "StepCompleted",
              body: { stepId: "scan", output: { repo: "acme/widgets", number: 9 } },
            },
          ],
        },
      ],
    });
    expect(isRepoCatchingUp(snapshot, "acme/widgets")).toBe(true);
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
