import type { GithubPullDetail, PrGithubWriteInput, PrItem } from "./hub-api.ts";
import { inboxAction, inboxStatus, primaryAction, primaryLabel, type PrimaryAction } from "./inbox-view.ts";

const UNTITLED = "Untitled pull request";

/** A verdict rendered before GitHub facts were read carries no title. */
export function titleText(title: string | null): string {
  return title === null ? UNTITLED : title;
}

export function verdictHeadline(item: Pick<PrItem, "running" | "state" | "evidence" | "nextAction">): string {
  if (item.running) return inboxStatus(item);
  if (item.nextAction !== null) return item.nextAction;
  const [firstEvidence] = item.evidence;
  return firstEvidence === undefined ? inboxStatus(item) : firstEvidence;
}

type PaneFacts = { title: string | null; author: string | null; draft: boolean | null; mergeable: boolean | null };

/** Once GitHub's detail has loaded it replaces the verdict's facts outright, so its null mergeable means GitHub is still computing it. */
export function paneFacts(item: PrItem, detail: GithubPullDetail | undefined): PaneFacts {
  if (detail === undefined) return { title: item.title, author: item.author, draft: item.draft, mergeable: item.mergeable };
  return { title: detail.pr.title, author: detail.pr.author, draft: detail.pr.draft, mergeable: detail.pr.mergeable };
}

type CiStatus = "passing" | "waiting";

const PASSING_CONCLUSION = /pass|success|neutral|skipped/i;

/** A check still running has no conclusion yet. */
function checkPassed(check: GithubPullDetail["checks"][number]): boolean {
  return check.conclusion !== null && PASSING_CONCLUSION.test(check.conclusion);
}

/** Null before GitHub has loaded or when the pull request has no checks. */
export function ciStatus(detail: GithubPullDetail | undefined): CiStatus | null {
  if (detail === undefined || detail.checks.length === 0) return null;
  return detail.checks.every(checkPassed) ? "passing" : "waiting";
}

type ActionBlocker = "no-number" | "running" | "read-only" | "busy" | "mergeability-unknown" | "not-mergeable" | "draft";

export type PaneGate = { item: PrItem; facts: PaneFacts; readOnly: boolean; busy: boolean };

/** Everything the pane can run: the GitHub writes, plus asking the hub to triage the pull request again. */
export type PaneKind = PrimaryAction | "triage";

function actionBlocker(kind: PaneKind, gate: PaneGate): ActionBlocker | null {
  if (gate.item.number === null) return "no-number";
  if (gate.item.running) return "running";
  if (gate.readOnly) return "read-only";
  if (gate.busy) return "busy";
  if (kind !== "merge") return null;
  if (gate.facts.mergeable === null) return "mergeability-unknown";
  if (!gate.facts.mergeable) return "not-mergeable";
  if (gate.facts.draft === true) return "draft";
  return null;
}

type PaneAction<K extends PaneKind = PaneKind> = { kind: K; blocker: ActionBlocker | null };

export type MenuEntry = PaneAction & { label: string; confirm: string | null };

type PaneActions = { primary: PaneAction<PrimaryAction> | null; more: MenuEntry[] };

const MORE_ORDER: PrimaryAction[] = ["approve", "changes", "comment", "merge"];

const PLAIN_CLOSE = { label: "Close pull request", confirm: "Close this pull request?" };

const TRIAGE_AGAIN = "Triage again";

function paneAction<K extends PaneKind>(kind: K, gate: PaneGate): PaneAction<K> {
  return { kind, blocker: actionBlocker(kind, gate) };
}

/** A flagged duplicate closes as one, even when that is already the suggested action; anything else may close plainly after a confirm, when writable. */
function closeEntry(gate: PaneGate): MenuEntry | null {
  const close = paneAction("close", gate);
  if (gate.item.canClose) return { ...close, label: primaryLabel("close"), confirm: null };
  if (close.blocker !== null) return null;
  return { ...close, ...PLAIN_CLOSE };
}

/** A pull request the hub has run before, or gave up on, can be run again; one still waiting for its first run cannot. */
function triageEntry(gate: PaneGate): MenuEntry | null {
  if (gate.item.runId === null && gate.item.failure === null) return null;
  return { ...paneAction("triage", gate), label: TRIAGE_AGAIN, confirm: null };
}

export function paneActions(gate: PaneGate): PaneActions {
  const action = inboxAction(gate.item);
  const primaryKind = action === null ? null : primaryAction(gate.item, action);
  const primary = primaryKind === null ? null : paneAction(primaryKind, gate);
  const more: MenuEntry[] = MORE_ORDER
    .filter((kind) => kind !== primaryKind)
    .map((kind) => ({ ...paneAction(kind, gate), label: primaryLabel(kind), confirm: null }));
  const close = closeEntry(gate);
  if (close !== null) more.push(close);
  const triage = triageEntry(gate);
  if (triage !== null) more.push(triage);
  return { primary, more };
}

export type ReplyDraft = { text: string; edited: boolean };

/** The text the reply editor starts from; a new verdict starts it over. */
export function draftText(item: Pick<PrItem, "comment">): string {
  return item.comment === null ? "" : item.comment;
}

/** Null when the verdict drafted no reply; the pane then has nothing to edit or post. */
export function replyDraft(item: PrItem, text: string): ReplyDraft | null {
  if (item.comment === null) return null;
  return { text, edited: text !== item.comment };
}

export function primaryButtonLabel(primary: PaneAction<PrimaryAction>, draft: ReplyDraft | null): string {
  if (primary.kind === "reply" && draft?.edited) return "Post edited reply";
  return primaryLabel(primary.kind);
}

type ComposerKind = "comment" | "changes";

export type Composer = { kind: ComposerKind; body: string };

export const COMPOSER_COPY: Record<ComposerKind, { placeholder: string; label: string; submit: string }> = {
  comment: { placeholder: "Write a comment", label: "Comment", submit: primaryLabel("comment") },
  changes: { placeholder: "What needs to change", label: "Requested changes", submit: primaryLabel("changes") },
};

export function openComposer(current: Composer | null, kind: ComposerKind): Composer {
  return { kind, body: current?.kind === kind ? current.body : "" };
}

export function isComposerKind(kind: PaneKind): kind is ComposerKind {
  return kind === "comment" || kind === "changes";
}

type GithubWrite = (input: PrGithubWriteInput) => Promise<void>;

export type PaneIo = { write: GithubWrite; triage: (repo: string, number: number) => Promise<void> };

type NumberedItem = PrItem & { number: number };

export function hasNumber(item: PrItem): item is NumberedItem {
  return item.number !== null;
}

export function canRun(kind: PaneKind, gate: PaneGate): boolean {
  return actionBlocker(kind, gate) === null;
}

export async function runPaneAction(
  kind: Exclude<PaneKind, ComposerKind>,
  item: NumberedItem,
  draft: ReplyDraft | null,
  io: PaneIo,
): Promise<string> {
  const { repo, number } = item;
  const { write } = io;
  switch (kind) {
    case "reply": {
      if (draft === null || !draft.text.trim()) throw new Error("The reply must not be empty.");
      await write({ action: "reply", repo, number, body: draft.text });
      if (item.labels.length > 0) await write({ action: "labels", repo, number, labels: item.labels });
      return `Posted to GitHub on #${number}.`;
    }
    case "approve":
      await write({ action: "review", repo, number, event: "APPROVE", body: "" });
      return `Approved #${number}.`;
    case "merge":
      await write({ action: "merge", repo, number });
      return `Merged #${number}.`;
    case "close":
      await write({ action: "close", repo, number, labels: item.labels, comment: item.comment ?? "" });
      return `Closed #${number}.`;
    case "triage":
      await io.triage(repo, number);
      return `Triage started for #${number}. It will show as Running shortly and its verdict will appear when it completes.`;
  }
}
