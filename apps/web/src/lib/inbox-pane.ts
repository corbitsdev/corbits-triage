import { errorText } from "@corbits/common";
import type { Outcome } from "./held-actions.ts";
import type { AutomationInput, GithubPullDetail, HeldBlock, HeldDoRef, MergeBlock, MergeState, PrGithubWriteInput, PrGithubWriteResult, PrItem } from "./hub-api.ts";
import type { PendingDo } from "./pending-dos.ts";
import { inboxAction, hasDraftComment, hasUncheckedCommits, primaryAction, primaryLabel, type HandledKind, type PrimaryAction } from "./inbox-view.ts";

const UNTITLED = "Untitled pull request";

/** A verdict rendered before GitHub facts were read carries no title. */
export function titleText(title: string | null): string {
  return title === null ? UNTITLED : title;
}

type HostBlock = "mergeability-unknown" | HeldBlock;

/** `hostBlock` is known once the host's detail, or the list's read of the host, has loaded. */
export type PaneFacts = { title: string | null; author: string | null; draft: boolean | null; mergeable: boolean | null; hostBlock: HostBlock | null };

const GITHUB_BLOCK: Partial<Record<string, HostBlock>> = { unknown: "mergeability-unknown", behind: "behind", blocked: "blocked" };

const REVIEW_BLOCK: Partial<Record<string, HostBlock>> = { REVIEW_REQUIRED: "review-required", CHANGES_REQUESTED: "changes-requested" };

function hostBlock(pr: Omit<MergeState, "number">): HostBlock | null {
  if (pr.canMerge === false) return "blocked";
  const block = pr.mergeableState === undefined ? undefined : GITHUB_BLOCK[pr.mergeableState];
  if (block === "blocked" && pr.reviewDecision) return REVIEW_BLOCK[pr.reviewDecision] ?? block;
  return block ?? null;
}

const CLEAR_STATES: ReadonlySet<string> = new Set(["clean", "unstable", "has_hooks"]);

/** Only the host's explicit yes clears the merge. */
export function mergeBlockOf(state: MergeState): MergeBlock | null {
  const block = hostBlock(state);
  if (block !== null) return block === "mergeability-unknown" ? "checking" : block;
  if (state.mergeable !== true) return "checking";
  return state.canMerge === true || (state.mergeableState !== undefined && CLEAR_STATES.has(state.mergeableState)) ? null : "checking";
}

/** Once GitHub's detail has loaded it replaces the verdict's facts outright, so its null mergeable means GitHub is still computing it. */
export function paneFacts(item: PrItem, detail: GithubPullDetail | undefined): PaneFacts {
  if (detail === undefined) return { title: item.title, author: item.author, draft: item.draft, mergeable: item.mergeable, hostBlock: item.mergeBlock === "checking" ? "mergeability-unknown" : item.mergeBlock };
  return { title: detail.pr.title, author: detail.pr.author, draft: detail.pr.draft, mergeable: detail.pr.mergeable, hostBlock: hostBlock(detail.pr) };
}

export type ActionBlocker = "no-number" | "running" | "read-only" | "busy" | "unchecked-commits" | "not-mergeable" | "draft" | HostBlock;

export type PaneGate = { item: PrItem; facts: PaneFacts; readOnly: boolean; busy: boolean };

export type PaneKind = PrimaryAction;

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
  if (hasUncheckedCommits(gate.item)) return "unchecked-commits";
  if (gate.facts.mergeable === null) return "mergeability-unknown";
  if (!gate.facts.mergeable) return "not-mergeable";
  if (gate.facts.draft === true) return "draft";
  return gate.facts.hostBlock;
}

type PaneAction<K extends PaneKind = PaneKind> = { kind: K; blocker: ActionBlocker | null };

export type MenuEntry = PaneAction & { label: string };

type PaneActions = { primary: PaneAction<PrimaryAction> | null; more: MenuEntry[] };

const MORE_ORDER: PrimaryAction[] = ["reply", "approve", "changes", "comment", "merge"];

const REVIEWS: ReadonlySet<PrimaryAction> = new Set(["approve", "changes"]);

/** A pull request Triage opened is merged rather than approved, and its changes are asked for on its host. */
function ownPullAction(kind: PrimaryAction | null): PrimaryAction | null {
  if (kind === "approve") return "merge";
  return kind === "changes" ? null : kind;
}

function paneAction<K extends PaneKind>(kind: K, gate: PaneGate): PaneAction<K> {
  return { kind, blocker: actionBlocker(kind, gate) };
}

function closeEntry(gate: PaneGate): MenuEntry | null {
  const close = paneAction("close", gate);
  if (close.blocker !== null) return null;
  return { ...close, label: primaryLabel("close") };
}

/** A pull request the hub has run before, or gave up on, can be run again; one still waiting for its first run cannot. */
function triageEntry(gate: PaneGate, primaryKind: PrimaryAction | null): MenuEntry | null {
  if (primaryKind === "triage") return null;
  if (gate.item.runId === null && gate.item.failure === null) return null;
  return { ...paneAction("triage", gate), label: primaryLabel("triage") };
}

export function paneActions(gate: PaneGate): PaneActions {
  const action = inboxAction(gate.item);
  const offered = primaryAction(gate.item, action);
  const primaryKind = gate.item.byTriage ? ownPullAction(offered) : offered;
  const primary = primaryKind === null ? null : paneAction(primaryKind, gate);
  const more: MenuEntry[] = MORE_ORDER
    .filter((kind) => kind !== primaryKind && (kind !== "reply" || hasDraftComment(gate.item.comment)) && !(gate.item.byTriage && REVIEWS.has(kind)))
    .map((kind) => ({ ...paneAction(kind, gate), label: primaryLabel(kind) }));
  const close = closeEntry(gate);
  if (close !== null) more.push(close);
  const triage = triageEntry(gate, primaryKind);
  if (triage !== null) more.push(triage);
  return { primary, more };
}

export type ReplyDraft = { text: string; edited: boolean };

export function draftText(item: Pick<PrItem, "comment">): string {
  return item.comment === null ? "" : item.comment;
}

/** Null when the verdict drafted no reply or an empty one; the pane then has nothing to edit or post. */
export function replyDraft(item: PrItem, text: string): ReplyDraft | null {
  if (!hasDraftComment(item.comment)) return null;
  return { text, edited: text !== item.comment };
}

type ComposerKind = "comment" | "changes";

export type Composer = { kind: ComposerKind; body: string };

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

/**
 * `replySent` records a reply the hub confirmed it wrote, so the row shows it posted until a new verdict; `approveDo`
 * approves a held pack Do by reference; `automate` lets Triage do a kind on its own in a repository from now on.
 */
type PaneIo = { write: GithubWrite; replySent: (item: PrItem) => void; approveDo: (ref: HeldDoRef) => Promise<void>; automate: (input: AutomationInput) => Promise<void> };

export type NumberedItem = PrItem & { number: number };

export function hasNumber(item: PrItem): item is NumberedItem {
  return item.number !== null;
}

export function canRun(kind: PaneKind, gate: PaneGate): boolean {
  return actionBlocker(kind, gate) === null;
}

export type WriteKind = HandledKind;

/**
 * A GitHub write as the inbox holds it: what the toast says while it waits for Undo, and how it is sent afterwards.
 * `settles` is recorded on the pull request it takes out of the inbox; null keeps it in the inbox and selected, for a write
 * that does not settle it. `restore` puts back what the pane hid when it held the write, on Undo or a failed send.
 */
export type PaneWrite = { pending: string; send: (io: PaneIo) => Promise<Outcome>; settles: WriteKind | null; restore?: () => void };

function requireBody(body: string, what: string): string {
  if (!body.trim()) throw new Error(`The ${what} must not be empty.`);
  return body;
}

function sent(message: string): Outcome {
  return { message, complete: true, kept: true };
}

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

function currentHead(item: Pick<PrItem, "headSha" | "verdictSha">): string | null {
  return item.headSha ?? item.verdictSha;
}

/** The head the pull request is approved on, so commits pushed since are not approved with it. */
export function approvedHead(item: PrItem): string {
  const sha = currentHead(item);
  if (sha === null) throw new Error("The pull request's head is not known yet. Refresh and try again.");
  return sha;
}

/** The head Triage checked, so commits pushed since are not merged unchecked: GitHub refuses a merge whose head has moved. */
export function checkedHead(item: PrItem): string {
  if (item.verdictSha === null) throw new Error("The commit Triage checked is not known. Triage it again before merging.");
  return item.verdictSha;
}

/** `body` is the reply draft for a reply and the composer text for a comment or requested changes. Throws before anything is held when there is nothing to send. */
export function paneWrite(kind: WriteKind, item: NumberedItem, body: string): PaneWrite {
  const { repo, number } = item;
  switch (kind) {
    case "reply": {
      const text = requireBody(body, "reply");
      return {
        settles: kind,
        pending: `Replying on #${number}…`,
        send(io) {
          return sendReply(io, item, text);
        },
      };
    }
    case "comment": {
      const text = requireBody(body, "comment");
      return {
        settles: kind,
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
        settles: kind,
        pending: `Requesting changes on #${number}…`,
        async send({ write }) {
          await write({ action: "review", repo, number, event: "REQUEST_CHANGES", body: text });
          return sent(`Requested changes on #${number}.`);
        },
      };
    }
    case "approve": {
      const headSha = approvedHead(item);
      return {
        settles: kind,
        pending: `Approving #${number}…`,
        async send({ write }) {
          await write({ action: "review", repo, number, event: "APPROVE", body: "", headSha });
          return sent(`Approved #${number}.`);
        },
      };
    }
    case "merge": {
      const headSha = checkedHead(item);
      return {
        settles: kind,
        pending: `Merging #${number}…`,
        async send({ write }) {
          await write({ action: "merge", repo, number, headSha });
          return sent(`Merged #${number}.`);
        },
      };
    }
    case "close":
      return {
        settles: kind,
        pending: `Closing #${number}…`,
        async send({ write }) {
          await write({ action: "close", repo, number, labels: item.labels, comment: item.comment ?? "" });
          return sent(`Closed #${number}.`);
        },
      };
  }
}

/**
 * A held Do is approved by reference, so pr-triage runs what the verdict recorded. Its close settles the pull request
 * like the pane's own close. `always` also lets Triage do its kind on its own in the repository once it is approved;
 * failing that leaves the approval sent and says Triage still asks.
 */
export function doWrite(item: NumberedItem, pending: PendingDo, restore: () => void, always: boolean): PaneWrite {
  const closes = pending.kind === "close";
  return {
    settles: closes ? "close" : null,
    restore,
    pending: `Approving ${pending.label} on #${item.number}…`,
    async send({ approveDo, automate }) {
      await approveDo(pending.ref);
      const approved = `Approved ${pending.label} on #${item.number}; Triage will run it.`;
      if (!always) return sent(approved);
      try {
        await automate({ repo: item.repo, source: item.source, kind: pending.kind, list: pending.list });
      } catch (cause) {
        return { message: `${approved} Triage still asks before doing this in ${item.repo}. ${errorText(cause)}`, complete: false, kept: true };
      }
      return sent(`${approved} From now on it does this on its own in ${item.repo}.`);
    },
  };
}

export function triageStartedText(number: number): string {
  return `Triage started for #${number}. It will show as Running shortly and its verdict will appear when it completes.`;
}
