// A verdict row as the verdict table records it, built from what a triage pass's evaluate, rules, mirror and execute
// steps output, however those outputs reached the hub.
import { type } from "arktype";
import { asRecord } from "@corbits/common";
import { VerdictDetail, type RepoSource } from "@corbits/triage-contracts";
import { NOT_ASKED_REASON } from "@corbits/triage-workflows/logic/render";
import { unsettledBy } from "@corbits/triage-workflows/logic/settled";
import type { RecordedDo, RecordedVerdict } from "./verdict-record-store.js";

export type Trigger = { repo: string; source: RepoSource; number: number; headSha: string; startedAt: string; event?: string };
export type Summary = Omit<RecordedVerdict, "runId" | "repo" | "number" | "headSha" | "startedAt">;
export type Ruled = { facts: Record<string, unknown>; evidence: string[] };

/** A webhook mail's `event:action`; catch-up and portal mails name none. */
export function eventOf(payload: Record<string, unknown>): string | undefined {
  const { event, action } = payload;
  return typeof event === "string" && typeof action === "string" ? `${event}:${action}` : undefined;
}

export const DoResult = type({ effectId: "string", status: "string", "error?": "string" });
export type DoResult = typeof DoResult.infer;

/** An execute step's Do outcomes by effect id. */
export function doResultsOf(output: Record<string, unknown> | undefined): Map<string, DoResult> {
  const dos = output?.["dos"];
  return new Map((Array.isArray(dos) ? dos : []).flatMap(function parsed(result): Array<[string, DoResult]> {
    const read = DoResult(result);
    return read instanceof type.errors ? [] : [[read.effectId, read]];
  }));
}

export function withResults(verdict: Record<string, unknown> | undefined, results: ReadonlyMap<string, DoResult>): Record<string, unknown> | undefined {
  const actions = verdict?.["actions"];
  if (!verdict || !Array.isArray(actions) || results.size === 0) return verdict;
  function withResult(action: unknown): unknown {
    const result = results.get(String(asRecord(action)?.["effectId"]));
    if (!result) return action;
    // The PR workflow holds an approve or merge its code review did not clear; it waits as one evaluate held.
    if (result.status === "held") return { ...asRecord(action), held: true, ...(result.error !== undefined && { reason: result.error }) };
    return { ...asRecord(action), status: result.status, ...(result.error !== undefined && { error: result.error }) };
  }
  return { ...verdict, actions: actions.map(withResult) };
}

/** The reasons the rules step's findings give, which the portal shows when the verdict names none. */
function evidenceOf(det: unknown): string[] {
  const findings = asRecord(det)?.["findings"];
  const reasons = [...(Array.isArray(findings) ? findings.map((finding) => asRecord(finding)?.["reason"]) : []), asRecord(det)?.["reason"]];
  return [...new Set(reasons.filter((reason): reason is string => typeof reason === "string" && reason !== ""))];
}

/** The facts the rules step read for each pull request, and its findings' reasons, by `repo#number`. */
export function ruledOf(output: Record<string, unknown> | undefined): Map<string, Ruled> {
  const items = output?.["items"];
  return new Map((Array.isArray(items) ? items : []).flatMap(function pull(item): Array<[string, Ruled]> {
    const facts = asRecord(asRecord(item)?.["facts"]);
    return facts ? [[`${String(facts["repo"])}#${String(facts["number"])}`, { facts, evidence: evidenceOf(asRecord(item)?.["det"]) }]] : [];
  }));
}

/** Mirror outcomes by call: a batch run outputs `{ results }`, a single run the one outcome. */
export function mirrorOutcomesOf(output: Record<string, unknown> | undefined): Map<string, Record<string, unknown>> {
  const outcomes = Array.isArray(output?.["results"]) ? output["results"] : [output];
  return new Map(outcomes.map(asRecord).flatMap((outcome) => outcome && typeof outcome["call"] === "string" ? [[outcome["call"], outcome] as const] : []));
}

/** Gates decide actions, not the verdict; a model check the verdict never asked about says nothing about the pull request. */
function recorded(c: { kind?: string; reason?: string; gate?: boolean }): boolean {
  return c.gate !== true && !(c.kind === "model" && c.reason === NOT_ASKED_REASON);
}

/** Why the mirror posted nothing for the verdict, when it said. */
function notPostedOf(outcome: Record<string, unknown> | undefined): string | undefined {
  return outcome?.["skipped"] === true && typeof outcome["reason"] === "string" ? outcome["reason"] : undefined;
}

function mirrorCallId(repo: string, number: number): string {
  return `mirror:${repo.replace("/", "--")}:${number}`;
}

const SummaryFields = type({
  state: "string",
  actor: "string",
  humanGated: "boolean",
  "degraded?": "string | null",
  "checks?": type({ check: "string", result: "string", "kind?": "string", "reason?": "string", "gate?": "boolean" }).array(),
  "actions?": "unknown[]",
  "request?": { comment: "string" },
});

function suggestedDos(actions: readonly unknown[]): RecordedDo[] {
  return actions.map(asRecord).flatMap(function suggested(action) {
    const list = action?.["list"];
    const effectId = action?.["effectId"];
    return typeof list === "string" && typeof effectId === "string" && action?.["skipped"] !== true ? [{ list, effectId }] : [];
  });
}

/** The verdict's own reason, else its rules' findings' reasons; a verdict made without rules gives none. */
function evidenceFor(reason: unknown, ruled: Ruled | undefined): string[] {
  if (typeof reason === "string" && reason !== "") return [reason];
  return ruled ? ruled.evidence : [];
}

function detailOf(verdict: Record<string, unknown>, ruled: Ruled | undefined, notPosted: string | undefined): VerdictDetail | undefined {
  const evidence = evidenceFor(verdict["reason"], ruled);
  const detail = VerdictDetail({ ...verdict, evidence, ...(ruled && { facts: ruled.facts }), ...(notPosted !== undefined && { notPosted }) });
  return detail instanceof type.errors ? undefined : detail;
}

/**
 * What the stats and the portal read of a verdict; none for one written before it carried these fields, made for
 * another head, still waiting on the host's checks, or made on a closed pull request.
 */
export function summaryOf(verdict: Record<string, unknown>, at: unknown, trigger: Trigger, mirrored: ReadonlyMap<string, Record<string, unknown>>, ruled: Ruled | undefined): Summary | undefined {
  if (verdict["waiting"] === true || verdict["closed"] === true) return undefined;
  const fields = SummaryFields(verdict);
  if (fields instanceof type.errors || typeof at !== "string" || verdict["repo"] !== trigger.repo || verdict["number"] !== trigger.number) return undefined;
  const outcome = mirrored.get(mirrorCallId(trigger.repo, trigger.number));
  const detail = detailOf(verdict, ruled, notPostedOf(outcome));
  return {
    verdictAt: new Date(at),
    settled: unsettledBy(verdict, trigger.headSha).unsettled === undefined,
    state: fields.state,
    actor: fields.actor,
    humanGated: fields.humanGated,
    degraded: fields.degraded ?? null,
    checks: fields.checks ? fields.checks.filter(recorded).map(({ check, result }) => ({ check, result })) : [],
    dos: fields.actions ? suggestedDos(fields.actions) : [],
    commented: fields.request !== undefined && fields.request.comment !== "" && outcome?.["ok"] === true,
    ...(detail && { detail }),
    ...(trigger.event !== undefined && { trigger: trigger.event }),
  };
}
