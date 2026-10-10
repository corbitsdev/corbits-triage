import { errorText } from "./error-text.ts";
import type { Outcome } from "./held-actions.ts";
import type { DoRef, DoRun, GithubPullDetail, PrGithubWriteInput, PrGithubWriteResult, PrItem } from "./hub-api.ts";
import { offersClose, type PendingDo } from "./pending-dos.ts";
import { inboxAction, inboxStatus, hasDraftComment, primaryAction, primaryLabel, type PrimaryAction } from "./inbox-view.ts";

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
export type PaneKind = PrimaryAction;

/** What stops any write to the pull request; merge has its own checks on top. */
export function writeBlocker(gate: PaneGate): ActionBlocker | null {
  if (gate.item.number === null) return "no-number";
  if (gate.item.running) return "running";
  if (gate.readOnly) return "read-only";
  if (gate.busy) return "busy";
  return null;
}

function actionBlocker(kind: PaneKind, gate: PaneGate): ActionBlocker | null {
  const blocker = writeBlocker(gate);
  if (blocker !== null || kind !== "merge") return blocker;
  if (gate.facts.mergeable === null) return "mergeability-unknown";
  if (!gate.facts.mergeable) return "not-mergeable";
  if (gate.facts.draft === true) return "draft";
  return null;
}

type PaneAction<K extends PaneKind = PaneKind> = { kind: K; blocker: ActionBlocker | null };

export type MenuEntry = PaneAction & { label: string };

type PaneActions = { primary: PaneAction<PrimaryAction> | null; more: MenuEntry[] };

const MORE_ORDER: PrimaryAction[] = ["reply", "approve", "changes", "comment", "merge"];

const PLAIN_CLOSE_LABEL = "Close pull request";

function paneAction<K extends PaneKind>(kind: K, gate: PaneGate): PaneAction<K> {
  return { kind, blocker: actionBlocker(kind, gate) };
}

/** A flagged duplicate closes as one, even when that is already the suggested action; anything else may close plainly, when writable and the pack offers no close of its own. */
function closeEntry(gate: PaneGate): MenuEntry | null {
  const close = paneAction("close", gate);
  if (gate.item.canClose) return { ...close, label: primaryLabel("close") };
  if (close.blocker !== null || offersClose(gate.item)) return null;
  return { ...close, label: PLAIN_CLOSE_LABEL };
}

/** A pull request the hub has run before, or gave up on, can be run again; one still waiting for its first run cannot. */
function triageEntry(gate: PaneGate, primaryKind: PrimaryAction | null): MenuEntry | null {
  if (primaryKind === "triage") return null;
  if (gate.item.runId === null && gate.item.failure === null) return null;
  return { ...paneAction("triage", gate), label: primaryLabel("triage") };
}

export function paneActions(gate: PaneGate): PaneActions {
  const action = inboxAction(gate.item);
  const primaryKind = primaryAction(gate.item, action);
  const primary = primaryKind === null ? null : paneAction(primaryKind, gate);
  const more: MenuEntry[] = MORE_ORDER
    .filter((kind) => kind !== primaryKind && (kind !== "reply" || hasDraftComment(gate.item.comment)))
    .map((kind) => ({ ...paneAction(kind, gate), label: primaryLabel(kind) }));
  const close = closeEntry(gate);
  if (close !== null) more.push(close);
  const triage = triageEntry(gate, primaryKind);
  if (triage !== null) more.push(triage);
  return { primary, more };
}

export type ReplyDraft = { text: string; edited: boolean };

/** The text the reply editor starts from; a new verdict starts it over. */
export function draftText(item: Pick<PrItem, "comment">): string {
  return item.comment === null ? "" : item.comment;
}

/** Null when the verdict drafted no reply or an empty one; the pane then has nothing to edit or post. */
export function replyDraft(item: PrItem, text: string): ReplyDraft | null {
  if (!hasDraftComment(item.comment)) return null;
  return { text, edited: text !== item.comment };
}

export function primaryButtonLabel(primary: PaneAction<PrimaryAction>, draft: ReplyDraft | null): string {
  if (primary.kind === "reply" && draft?.edited) return "Post edited reply";
  return primaryLabel(primary.kind);
}

type ComposerKind = "comment" | "changes";

export type Composer = { kind: ComposerKind; body: string };

/** What the user had typed in the pane, put back when an action is undone or its send fails. */
export type PaneDraft = { reply: string; composer: Composer | null };

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

type GithubWrite = (input: PrGithubWriteInput) => Promise<PrGithubWriteResult>;

/** `replySent` records a reply the hub confirmed it wrote, so the row shows it posted until a new verdict; `runDo` runs a pack Do by reference. */
export type PaneIo = { write: GithubWrite; replySent: (item: PrItem) => void; runDo: (ref: DoRef) => Promise<DoRun> };

export type NumberedItem = PrItem & { number: number };

export function hasNumber(item: PrItem): item is NumberedItem {
  return item.number !== null;
}

export function canRun(kind: PaneKind, gate: PaneGate): boolean {
  return actionBlocker(kind, gate) === null;
}

/** Closing a flagged duplicate tells a contributor their work is not wanted, so it is confirmed before it is held. */
export function needsConfirm(kind: PaneKind, item: PrItem): boolean {
  return kind === "close" && item.canClose;
}

export type WriteKind = Exclude<PaneKind, "triage">;

/**
 * A GitHub write as the inbox holds it: what the toast says while it waits for Undo, and how it is sent afterwards.
 * `stay` keeps the pull request in the inbox and selected, for a write that does not settle it; `restore` puts back
 * what the pane hid when it held the write, on Undo or a failed send.
 */
export type PaneWrite = { pending: string; send: (io: PaneIo) => Promise<Outcome>; stay?: boolean; restore?: () => void };

function requireBody(body: string, what: string): string {
  if (!body.trim()) throw new Error(`The ${what} must not be empty.`);
  return body;
}

function sent(message: string): Outcome {
  return { message, complete: true, kept: true };
}

/** A reply the hub did not confirm was not posted, as far as anyone can tell. */
function replyFailure(replied: PromiseSettledResult<PrGithubWriteResult>): string | null {
  if (replied.status === "rejected") return errorText(replied.reason);
  return replied.value.commentId === null ? "The hub did not confirm the reply was posted." : null;
}

/**
 * The reply and its labels start together, so both are on their way when the page is being left.
 * Each half that reached GitHub is reported as such: a posted reply keeps the pull request out of the inbox,
 * while labels alone bring it back with the reply to post again.
 */
async function sendReply({ write, replySent }: PaneIo, item: NumberedItem, body: string): Promise<Outcome> {
  const { repo, number } = item;
  const reply = write({ action: "reply", repo, number, body });
  const labels = item.labels.length > 0 ? [write({ action: "labels", repo, number, labels: item.labels })] : [];
  const [replied, labeled] = await Promise.allSettled([reply, ...labels]);
  const failure = replyFailure(replied);
  if (failure !== null) {
    if (labeled?.status !== "fulfilled") throw new Error(failure);
    return { message: `Labels added to #${number}; the reply was not posted. ${failure}`, complete: false, kept: false };
  }
  replySent(item);
  if (labeled?.status === "rejected") return { message: `Reply posted to #${number}; labels were not added. ${errorText(labeled.reason)}`, complete: false, kept: true };
  return sent(`Posted to GitHub on #${number}.`);
}

/** `body` is the reply draft for a reply and the composer text for a comment or requested changes. Throws before anything is held when there is nothing to send. */
export function paneWrite(kind: WriteKind, item: NumberedItem, body: string): PaneWrite {
  const { repo, number } = item;
  switch (kind) {
    case "reply": {
      const text = requireBody(body, "reply");
      return {
        pending: `Replying on #${number}…`,
        send(io) {
          return sendReply(io, item, text);
        },
      };
    }
    case "comment": {
      const text = requireBody(body, "comment");
      return {
        pending: `Commenting on #${number}…`,
        async send({ write }) {
          await write({ action: "comment", repo, number, body: text });
          return sent(`Commented on #${number}.`);
        },
      };
    }
    case "changes": {
      const text = requireBody(body, "comment");
      return {
        pending: `Requesting changes on #${number}…`,
        async send({ write }) {
          await write({ action: "review", repo, number, event: "REQUEST_CHANGES", body: text });
          return sent(`Requested changes on #${number}.`);
        },
      };
    }
    case "approve":
      return {
        pending: `Approving #${number}…`,
        async send({ write }) {
          await write({ action: "review", repo, number, event: "APPROVE", body: "" });
          return sent(`Approved #${number}.`);
        },
      };
    case "merge":
      return {
        pending: `Merging #${number}…`,
        async send({ write }) {
          await write({ action: "merge", repo, number });
          return sent(`Merged #${number}.`);
        },
      };
    case "close":
      return {
        pending: item.canClose ? `Closing #${number} as a duplicate…` : `Closing #${number}…`,
        async send({ write }) {
          await write({ action: "close", repo, number, labels: item.labels, comment: item.comment ?? "" });
          return sent(item.canClose ? `Closed #${number} as a duplicate.` : `Closed #${number}.`);
        },
      };
  }
}

/** A pack Do is sent by reference, so the hub runs what the verdict recorded. Its close settles the pull request like the pane's own close. */
export function doWrite(item: NumberedItem, pending: PendingDo, restore: () => void): PaneWrite {
  const closes = pending.kind === "close";
  return {
    stay: !closes,
    restore,
    pending: closes ? `Closing #${item.number}…` : `${pending.label} on #${item.number}…`,
    async send({ runDo }) {
      await runDo(pending.ref);
      return sent(closes ? `Closed #${item.number}.` : `${pending.label}: done on #${item.number}.`);
    },
  };
}

export function triageStartedText(number: number): string {
  return `Triage started for #${number}. It will show as Running shortly and its verdict will appear when it completes.`;
}
