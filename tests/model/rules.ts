// The rules in docs/INVARIANTS.md that a settled pull request is checked against: what GitHub ends up holding, the
// writes each pass made, and what is left of its runs and mail.
import { isTriageComment } from "@corbits/github-reads";
import { HTML_MARKERS, WAITING_LABEL } from "@corbits/triage-contracts";
import type { Played } from "./events.ts";
import type { modelStack, PassWrites } from "./stack.ts";

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

/** R3: no pass posts its comment twice or adds one label twice. */
function onceEach({ pass, writes }: PassWrites): string[] {
  const posts = writes.filter((write) => write.method === "POST");
  const comments = posts.filter((write) => write.path.endsWith("/comments")).length;
  const added = posts.filter((write) => write.path.endsWith("/labels")).flatMap((write) => (write.body as { labels: string[] }).labels);
  const breaks = comments > 1 ? [`R3: pass ${pass} posted ${comments} comments`] : [];
  for (const label of new Set(added)) {
    const times = added.filter((name) => name === label).length;
    if (times > 1) breaks.push(`R3: pass ${pass} added ${label} ${times} times`);
  }
  return breaks;
}

/** Each rule the settled pull request breaks, by its number, saying how; `missed` is how many misses the fake GitHub had before it. */
export async function broken(stack: Stack, pull: Played, missed: number): Promise<string[]> {
  const { live, queued, lost, failed } = await stack.leftover(pull.number);
  const breaks = [...oneVerdict(stack, pull), ...stack.passWrites(pull.number).flatMap(onceEach)];
  if (live.length > 0) breaks.push(`R5: managers still live: ${live.join(", ")}`);
  if (queued.length > 0) breaks.push(`R5: ${queued.length} mails left undelivered`);
  if (lost.length > 0) breaks.push(`R5: mail no run took: ${lost.map((mail) => mail.to).join(", ")}`);
  if (failed.length > 0) breaks.push(`runs that did not complete: ${failed.join(", ")}`);
  const misses = stack.github.misses.slice(missed);
  if (misses.length > 0) breaks.push(`the fake GitHub was asked what it does not serve: ${misses.join(", ")}`);
  return breaks;
}
