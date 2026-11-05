// The rules in docs/INVARIANTS.md that a settled pull request is checked against: what GitHub ends up holding, the
// writes it received, and what is left of its runs and mail.
import { isTriageComment } from "@corbits/github-reads";
import { closedText, HTML_MARKERS, TRIAGE_LABELS, VERDICT_LABELS, WAITING_LABELS, type Awaits } from "@corbits/triage-contracts";
import { progressComment } from "@corbits/triage-workflows/logic/render";
import type { Write } from "../chain/github.ts";
import type { Played } from "./events.ts";
import type { modelStack } from "./stack.ts";

type Stack = Awaited<ReturnType<typeof modelStack>>;

/** More takes than this by one manager on one head is a manager polling for what will not come; the model needs two. */
const TAKES_PER_HEAD = 4;

const PROGRESS_TITLE = "**Triage: In progress**";

/** The title a verdict comment opens with under its marker, by the verdict its header names. */
const VERDICT_TITLES: Record<string, string> = { pass: "**Triage: Pass**", fail: "**Triage: Fail**", unsure: "**Triage: Unsure**" };

/**
 * R1: exactly one current Triage comment, a verdict on the head, and no waiting label left. A pull request that closed
 * keeps a verdict it had on its last head, or else says it closed before Triage finished, with none of Triage's labels;
 * one closed before any comment went up has none.
 */
function oneVerdict(stack: Stack, pull: Played): string[] {
  const { comments, labels } = stack.github.pull(stack.repo, pull.number);
  const head = pull.heads.at(-1)!;
  const current = comments.filter((comment) => isTriageComment(comment.body) && !HTML_MARKERS.isSuperseded(comment.body));
  const breaks: string[] = [];
  if (current.length !== 1 && !(pull.closed && current.length === 0)) breaks.push(`R1: ${current.length} current Triage comments`);
  for (const { body } of current) {
    const header = HTML_MARKERS.headerOf(body);
    const line = body.split("\n")[1];
    if (pull.closed && line === closedText(pull.closed === "merged", head)) {
      const left = labels.filter((label) => TRIAGE_LABELS.includes(label));
      if (left.length > 0) breaks.push(`R1: the pull request closed before Triage finished still has ${left.join(", ")}`);
      continue;
    }
    if (header?.head !== head) breaks.push(`R1: the Triage comment names ${header?.head}, not the head ${head}`);
    const title = header && VERDICT_TITLES[header.verdict];
    if (!title || line !== title) breaks.push(`R1: the Triage comment is no verdict: ${line}`);
  }
  const waiting = labels.filter((label) => Object.values(WAITING_LABELS).includes(label));
  if (waiting.length > 0) breaks.push(`R1: the pull request still has ${waiting.join(", ")}`);
  return breaks;
}

/**
 * R1 on a pull request that kept its first head: once a verdict is up on it, no later write turns it back into a progress
 * comment. Only sequences that play no Review again are checked with it, since one rightly shows code review in progress
 * again on the same head.
 */
export function verdictKept(stack: Stack, pull: Played): string[] {
  if (pull.heads.length !== 1) throw new Error(`verdictKept checks a pull request on one head, not ${pull.heads.length}`);
  let posted = false;
  for (const { body } of stack.writes(pull.number)) {
    const text = (body as { body?: unknown } | null)?.body;
    if (typeof text !== "string" || !isTriageComment(text)) continue;
    const title = text.split("\n")[1]!;
    if (Object.values(VERDICT_TITLES).includes(title)) posted = true;
    else if (posted) return [`R1: the verdict on ${pull.heads[0]} was replaced by ${title}`];
  }
  return [];
}

/**
 * R3, over every write the pull request received, whichever pass made it: a Triage comment is created only while none
 * is current, so never twice unless the one before was superseded, and no label is added while it is on.
 */
function onceEach(writes: readonly Write[]): string[] {
  const breaks: string[] = [];
  let current = 0;
  const on = new Set<string>();
  for (const { method, path, body } of writes) {
    const text = (body as { body?: unknown } | null)?.body;
    if (method === "POST" && path.endsWith("/comments") && typeof text === "string" && isTriageComment(text)) {
      if (current > 0) breaks.push("R3: a Triage comment was created while one was current");
      current += 1;
    } else if (method === "PATCH" && path.includes("/issues/comments/") && typeof text === "string" && HTML_MARKERS.isSuperseded(text)) {
      current -= 1;
    } else if (method === "POST" && path.endsWith("/labels")) {
      for (const label of (body as { labels: string[] }).labels) {
        if (on.has(label)) breaks.push(`R3: ${label} was added while it was on`);
        on.add(label);
      }
    } else if (method === "DELETE" && path.includes("/labels/")) {
      on.delete(decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)));
    }
  }
  return breaks;
}

/**
 * R7, over every write the pull request received: whenever a Triage comment is written, and once it settles, the
 * waiting labels the pull request holds name what its in-progress comment waits for, and none stand beside a verdict.
 * Not Ready and Needs Human Review keep the labels as they are until the verdict.
 */
function waitingNamed(writes: readonly Write[]): string[] {
  const breaks: string[] = [];
  const on = new Set<string>();
  let shown: string | undefined;
  function check(): void {
    if (shown === undefined || [VERDICT_LABELS.fail, VERDICT_LABELS.unsure].some((label) => on.has(label))) return;
    const awaits = (Object.keys(WAITING_LABELS) as Awaits[]).filter((awaited) => on.has(WAITING_LABELS[awaited]));
    const labels = awaits.map((awaited) => WAITING_LABELS[awaited]).join(", ") || "no waiting label";
    const progress = shown.includes(PROGRESS_TITLE);
    if (!progress && awaits.length > 0) breaks.push(`R7: ${labels} beside a verdict`);
    // What the comment already shows of the verdict sits between its title and what it waits for.
    if (progress && (awaits.length === 0 || !shown.endsWith(progressComment(awaits).slice(PROGRESS_TITLE.length)))) breaks.push(`R7: ${labels} beside ${shown.slice(shown.indexOf(PROGRESS_TITLE))}`);
  }
  for (const { method, path, body } of writes) {
    const text = (body as { body?: unknown } | null)?.body;
    if ((method === "POST" || method === "PATCH") && path.includes("/comments") && typeof text === "string" && isTriageComment(text) && !HTML_MARKERS.isSuperseded(text)) {
      check();
      shown = text;
    } else if (method === "POST" && path.endsWith("/labels")) {
      for (const label of (body as { labels: string[] }).labels) on.add(label);
    } else if (method === "DELETE" && path.includes("/labels/")) {
      on.delete(decodeURIComponent(path.slice(path.lastIndexOf("/") + 1)));
    }
  }
  check();
  return breaks;
}

/** Each rule the settled pull request breaks, by its number, saying how; `missed` is how many misses the fake GitHub had before it. */
export async function broken(stack: Stack, pull: Played, missed: number): Promise<string[]> {
  const { live, unattributed, lost, failed, waited, exhausted, mostTakes } = await stack.leftover(pull.number);
  const breaks = [...oneVerdict(stack, pull), ...onceEach(stack.writes(pull.number)), ...waitingNamed(stack.writes(pull.number))];
  if (live.length > 0) breaks.push(`R5: managers still live: ${live.join(", ")}`);
  if (unattributed.length > 0) breaks.push(`R5: live managers deployed for no single pull request: ${unattributed.join(", ")}`);
  if (lost.length > 0) breaks.push(`R5: mail no run took: ${lost.map((mail) => mail.to).join(", ")}`);
  if (waited.length > 0) breaks.push(`R7: a manager kept waiting on code review runs that had ended: ${waited.join(", ")}`);
  if (exhausted.length > 0) breaks.push(`R7: managers ran out of passes: ${exhausted.join(", ")}`);
  if (mostTakes > TAKES_PER_HEAD) breaks.push(`R7: a manager took the pull request ${mostTakes} times on one head`);
  if (failed.length > 0) breaks.push(`runs that did not complete: ${failed.join(", ")}`);
  const misses = stack.github.misses.slice(missed);
  if (misses.length > 0) breaks.push(`the fake GitHub was asked what it does not serve: ${misses.join(", ")}`);
  return breaks;
}
