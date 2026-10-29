import { asRecord } from "@corbits/common";
import { isModelCheck, LEGACY_SCHEMA_VERSION, VERDICTS, type ActionKind, type CheckPack, type ModelCustomCheck, type Step } from "./check-pack.js";
import type { RepoSource } from "./repo-source.js";

export const TRIAGE_MAIL_SENDER = "github";

/**
 * Who may mail a triage deployment: the hub's sender is a principal in the deployment's own tenant, so the tenant rule
 * admits it and refuses every other tenant; the steps then act only on mail from {@link isFromTriageSender}.
 */
export const TRIAGE_MAIL_ACCEPT = { tenant: true };

const BARE_ADDRESS = /^([^\s@<>",()]+)@([^\s@<>",()]+)$/;

function bareAddress(value: unknown): { local: string; domain: string } | undefined {
  const match = typeof value === "string" ? BARE_ADDRESS.exec(value.trim()) : null;
  return match ? { local: match[1]!, domain: match[2]!.toLowerCase() } : undefined;
}

/**
 * Whether the trigger mail came from the hub's triage sender. Stock admits a mail only when its `From` names the sender
 * the hub authenticated, but a display name is free text, so only the bare address the hub writes is trusted, and only
 * from the domain of the deployment it was sent to.
 */
export function isFromTriageSender(payload: unknown): boolean {
  const headers = asRecord(asRecord(parsed(payload))?.["headers"]);
  const from = bareAddress(headers?.["from"]);
  const to = headers?.["to"];
  if (from?.local !== TRIAGE_MAIL_SENDER || !Array.isArray(to) || to.length !== 1) return false;
  return bareAddress(to[0])?.domain === from.domain;
}

function parsed(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

/** The request a run's trigger carried: stock stores the trigger mail with the request JSON as inline text of a part (none for a part stored by ref), and callers may also pass the request itself or its JSON. */
export function triggerRequestOf(payload: unknown): Record<string, unknown> | undefined {
  const value = asRecord(parsed(payload));
  if (!value) return undefined;
  if (typeof value["kind"] === "string") return value;
  const parts = value["parts"];
  if (!Array.isArray(parts)) return undefined;
  for (const part of parts) {
    const request = triggerRequestOf(asRecord(part)?.["text"]);
    if (request) return request;
  }
  return undefined;
}

/**
 * A step's request and whether it carries the hub's authority: a mail from the hub's sender, or the request a manager's
 * take read back from the hub, which the manager hands over as the step's whole input `{ taken }`. A mail is never that.
 */
export function trustedRequestOf(input: unknown): { request: Record<string, unknown> | undefined; trusted: boolean } {
  const record = asRecord(input);
  const taken = asRecord(record?.["taken"]);
  if (taken && Object.keys(record!).length === 1) return { request: taken, trusted: true };
  return { request: triggerRequestOf(input), trusted: isFromTriageSender(input) };
}

export const APPROVE_DO_KIND = "approve-do";

/** Whether triage marks a head waiting on its CI: where it writes the verdict, as labels on GitHub where it holds labels, and as the build status, always written, on Bitbucket Data Center. */
export function marksWaiting(source: RepoSource, automatic: readonly ActionKind[]): boolean {
  return source === "bitbucket-datacenter" || automatic.includes("labels");
}

/** A Do as deployments built before steps read it; one they cannot run as the policy means is left out. */
function legacyDo(step: Step) {
  if (step.when !== undefined || step.do === "merge" || step.do === "nothing") return [];
  if (step.do === "labels" && step.target.from === "rules") return [];
  return [{ kind: step.do, target: "target" in step ? step.target : {} }];
}

/** A score row as deployments built before levels read it: `min` on 0 to 10 at its `failBelow`, or 0, which never fails. */
function legacyCustom(row: ModelCustomCheck) {
  if (row.shape !== "score") return row;
  const { levels, failBelow, ...rest } = row;
  const at = failBelow === undefined ? 0 : levels.indexOf(failBelow);
  return { ...rest, min: Math.round((at * 10) / (levels.length - 1)) };
}

/**
 * The pack as deployments built before steps read it, mailed as `checkPack` beside the pack itself as `pack`, which
 * they never read: each list holds the Dos of the steps they can run as the policy means, and text rules, which they
 * cannot read, are left out.
 */
export function legacyCheckPack(pack: CheckPack) {
  const [pass, fail, unsure] = VERDICTS.map((list) => pack.actions[list].flatMap(legacyDo));
  const { dropped: _dropped, labels: _labels, ...rest } = pack;
  return { ...rest, schemaVersion: LEGACY_SCHEMA_VERSION, custom: pack.custom.filter(isModelCheck).map(legacyCustom), actions: { when: pack.actions.when, pass, fail, unsure } };
}
