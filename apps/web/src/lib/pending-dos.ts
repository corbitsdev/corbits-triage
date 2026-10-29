import { alwaysHeld, type ActionKind, type VerdictWord } from "@corbits/triage-contracts";
import { strings, type HeldDoRef, type PrItem, type SuggestedAction } from "./hub-api.ts";

/**
 * `sentKey` also names the status it had when approved, so a later failure offers it again. `until` is what lets an
 * action the policy has Triage take on its own run without you, null for one that waits on you.
 */
export type PendingDo = { key: string; sentKey: string; label: string; list: VerdictWord; kind: ActionKind; reason: string; ref: HeldDoRef; error: string | null; until: string | null };

/** Resolution keeps only team slugs, and only the repository owner's teams can review. */
function teamName(slug: string, repo: string): string {
  return `@${repo.split("/", 1)[0]}/${slug}`;
}

const PREVIEW_MAX = 40;

/** A held comment or change request posts its own text, not Triage's drafted feedback, so its button names what it posts. */
function preview(body: string): string {
  const line = body.trim().split("\n", 1)[0];
  return line.length > PREVIEW_MAX ? `${line.slice(0, PREVIEW_MAX).trimEnd()}…` : line;
}

function phrase(verb: string, object: string | null): string | null {
  return object === null ? null : `${verb} ${object}`;
}

function labelsText(target: Record<string, unknown>): string | null {
  const labels = strings(target.labels);
  if (labels.length === 0) return null;
  return `${labels.length === 1 ? "label" : "labels"} ${labels.join(", ")}`;
}

function listText(names: string[]): string | null {
  return names.length ? names.join(", ") : null;
}

function reviewersText(target: Record<string, unknown>, repo: string): string | null {
  return listText([...strings(target.teams).map((slug) => teamName(slug, repo)), ...strings(target.users)]);
}

function bodyText(target: Record<string, unknown>): string | null {
  return typeof target.body === "string" && target.body.trim() ? `"${preview(target.body)}"` : null;
}

function label(action: SuggestedAction, repo: string): string | null {
  const { kind, target } = action;
  if ("unresolved" in target) return null;
  switch (kind) {
    case "labels":
      return phrase("Add", labelsText(target));
    case "assign":
      return phrase("Assign", listText(strings(target.users)));
    case "request-review":
      return phrase("Request review from", reviewersText(target, repo));
    case "comment":
      return phrase("Comment", bodyText(target));
    case "approve":
      return "Approve";
    case "request-changes":
      return phrase("Request changes", bodyText(target));
    case "close":
      return "Close";
    case "merge":
      return "Merge";
  }
}

function pastText(action: SuggestedAction, repo: string): string | null {
  const { kind, target } = action;
  if ("unresolved" in target) return null;
  switch (kind) {
    case "labels":
      return phrase("added", labelsText(target));
    case "assign":
      return phrase("assigned", listText(strings(target.users)));
    case "request-review":
      return phrase("requested review from", reviewersText(target, repo));
    case "comment":
      return phrase("commented", bodyText(target));
    case "approve":
      return "approved this pull request";
    case "request-changes":
      return phrase("requested changes", bodyText(target));
    case "close":
      return "closed this pull request";
    case "merge":
      return "merged this pull request";
  }
}

function awaitsApproval({ held, status }: SuggestedAction): boolean {
  return status === undefined ? held : status === "failed" || status === "skipped";
}

const REVIEWS: ReadonlySet<ActionKind> = new Set(["approve", "request-changes"]);

/** The host refuses a review from a pull request's author, so one Triage opened offers none. */
function offered(item: PrItem, action: SuggestedAction): boolean {
  return awaitsApproval(action) && !(item.byTriage && REVIEWS.has(action.kind));
}

/** Triage may take it on its own and the hub says only running CI holds it, so the run after CI finishes takes it. */
function heldForCi(item: PrItem, action: SuggestedAction): boolean {
  return action.held && action.heldUntil === "ci-finishes" && action.status === undefined && item.automatic.includes(action.kind) && !alwaysHeld(action.list, action.kind);
}

function untilText(item: PrItem, action: SuggestedAction): string | null {
  return heldForCi(item, action) ? "CI finishes" : null;
}

function sentKeyOf(action: SuggestedAction): string {
  return `${action.effectId}:${action.status ?? "held"}`;
}

/** Drops the Dos skipped in this browser or waiting on their approval to send, so the pull request holds only those left to decide. */
export function withoutDecidedDos(item: PrItem, hidden: ReadonlySet<string>, sent: ReadonlySet<string>): PrItem {
  return { ...item, actions: item.actions.filter((action) => !hidden.has(action.effectId) && !sent.has(sentKeyOf(action))) };
}

export function pendingDos(item: PrItem): PendingDo[] {
  const { repo, number, runId } = item;
  if (number === null || runId === null) return [];
  const out: PendingDo[] = [];
  for (const action of item.actions) {
    const text = offered(item, action) ? label(action, repo) : null;
    if (text === null) continue;
    const ref = { runId, repo, number, effectId: action.effectId, kind: action.kind };
    // A merge may be approved off a Fail or Unsure list, and the card says so.
    const shown = action.kind === "merge" && action.list !== "pass" ? `${text} (the verdict was ${action.list}, not pass)` : text;
    out.push({ key: action.effectId, sentKey: sentKeyOf(action), label: shown, list: action.list, kind: action.kind, reason: action.reason, ref, error: action.error ?? null, until: untilText(item, action) });
  }
  return out;
}

/**
 * What a person is offered on a held Do: its button runs it once as them, which needs the Do's grant; "Always" also lets
 * Triage do its kind on its own in the repository, which needs grant create and a kind the policy file names
 * (`wanted`), and never for a kind this verdict always holds. One that runs on its own once CI finishes offers neither.
 */
export function heldOffer(pending: Pick<PendingDo, "list" | "kind" | "until">, access: { holdsDo: boolean; createsGrants: boolean; wanted: readonly ActionKind[] }): { doIt: boolean; always: boolean } {
  const doIt = access.holdsDo && pending.until === null;
  return { doIt, always: doIt && access.createsGrants && access.wanted.includes(pending.kind) && !alwaysHeld(pending.list, pending.kind) };
}

/** The pack's close stands in for the plain one, so only one Close is offered. */
export function offersClose(item: PrItem): boolean {
  return pendingDos(item).some((pending) => pending.kind === "close");
}

/** Only a held action waits on a person: the next run tries an unattended one again, one held only for CI runs once CI allows, and a refused one cannot run. */
export function holdsActionForYou(item: PrItem): boolean {
  return item.actions.some((action) => action.held && (action.status === undefined || action.status === "failed") && !heldForCi(item, action) && label(action, item.repo) !== null);
}

/** What Triage posted on its own for this verdict, said in the past tense. */
export function postedActions(item: PrItem): string[] {
  return item.actions.flatMap((action) => (item.automatic.includes(action.kind) && action.status === "done" ? [pastText(action, item.repo)].filter((text) => text !== null) : []));
}

/** This verdict has a merge step Triage will run without asking. */
export function mergesOnItsOwn(item: PrItem): boolean {
  return item.actions.some((action) => action.kind === "merge" && !awaitsApproval(action) && action.status !== "done" && action.status !== "satisfied");
}

export function joined(phrases: string[]): string {
  if (phrases.length < 2) return phrases.join("");
  return `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/**
 * What the policy has Triage do on its own here, and why: past tense only for what it posted, and the rest as not posted yet.
 * An action already in place before Triage ran is left out, since Triage did nothing. Null when there is nothing to say.
 */
export function triageActed(item: PrItem): { did: string; reason: string } | null {
  const done: string[] = [];
  const unrun: string[] = [];
  let reason: string | null = null;
  for (const action of item.actions) {
    if (!item.automatic.includes(action.kind) || awaitsApproval(action) || action.status === "satisfied") continue;
    const posted = action.status === "done";
    const text = posted ? pastText(action, item.repo) : label(action, item.repo);
    if (text === null) continue;
    if (posted) done.push(text);
    else unrun.push(text);
    reason ??= action.reason;
  }
  if (reason === null) return null;
  const sentences = [done.length ? `Triage ${joined(done)}.` : null, unrun.length ? `Not posted yet: ${unrun.join(", ")}.` : null];
  return { did: sentences.filter((sentence) => sentence !== null).join(" "), reason };
}
