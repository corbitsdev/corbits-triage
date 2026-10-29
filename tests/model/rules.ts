// The rules in docs/INVARIANTS.md that a settled pull request is checked against: what GitHub ends up holding, the
// writes it received, and what is left of its runs and mail.
import { isTriageComment } from "@corbits/github-reads";
import { HTML_MARKERS, WAITING_LABEL } from "@corbits/triage-contracts";
import type { Write } from "../chain/github.ts";
import type { Played } from "./events.ts";
import type { modelStack } from "./stack.ts";

type Stack = Awaited<ReturnType<typeof modelStack>>;

/** The title a verdict comment opens with under its marker, by the verdict its header names. */
const VERDICT_TITLES: Record<string, string> = { pass: "**Triage: Pass**", fail: "**Triage: Fail**", unsure: "**Triage: Unsure**" };

/** R1: exactly one current Triage comment, a verdict on the head, and no waiting label left. */
function oneVerdict(stack: Stack, pull: Played): string[] {
  const { comments, labels } = stack.github.pull(stack.repo, pull.number);
  const head = pull.heads.at(-1)!;
  const current = comments.filter((comment) => isTriageComment(comment.body) && !HTML_MARKERS.isSuperseded(comment.body));
  const breaks: string[] = [];
  if (current.length !== 1) breaks.push(`R1: ${current.length} current Triage comments`);
  for (const { body } of current) {
    const header = HTML_MARKERS.headerOf(body);
    if (header?.head !== head) breaks.push(`R1: the Triage comment names ${header?.head}, not the head ${head}`);
    const title = header && VERDICT_TITLES[header.verdict];
    if (!title || body.split("\n")[1] !== title) breaks.push(`R1: the Triage comment is no verdict: ${body.split("\n")[1]}`);
  }
  if (labels.includes(WAITING_LABEL)) breaks.push(`R1: the pull request still has ${WAITING_LABEL}`);
  return breaks;
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

/** Each rule the settled pull request breaks, by its number, saying how; `missed` is how many misses the fake GitHub had before it. */
export async function broken(stack: Stack, pull: Played, missed: number): Promise<string[]> {
  const { live, unattributed, lost, failed } = await stack.leftover(pull.number);
  const breaks = [...oneVerdict(stack, pull), ...onceEach(stack.writes(pull.number))];
  if (live.length > 0) breaks.push(`R5: managers still live: ${live.join(", ")}`);
  if (unattributed.length > 0) breaks.push(`R5: live managers deployed for no single pull request: ${unattributed.join(", ")}`);
  if (lost.length > 0) breaks.push(`R5: mail no run took: ${lost.map((mail) => mail.to).join(", ")}`);
  if (failed.length > 0) breaks.push(`runs that did not complete: ${failed.join(", ")}`);
  const misses = stack.github.misses.slice(missed);
  if (misses.length > 0) breaks.push(`the fake GitHub was asked what it does not serve: ${misses.join(", ")}`);
  return breaks;
}
