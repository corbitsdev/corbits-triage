import type { PostedCodeReview } from "@corbits/github-reads";
import { CORBITS_MARK_PATH } from "@corbits/react-ui";
import { findingTitle, POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { clock } from "../clock.ts";
import type { PolicyOrigin } from "../policy-source.ts";
import type { RunState } from "../storage.ts";
import type { Posted, RuleState, TriageView, ViewRule } from "../view.ts";
import { summaryOf } from "./chip.ts";

const STATE_NAMES: Record<RuleState, string> = { pass: "Pass", fail: "Fail", waiting: "Waiting", "not-evaluated": "Not evaluated here" };
const ORDER: Record<RuleState, number> = { fail: 0, waiting: 1, "not-evaluated": 2, pass: 3 };

function node<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const made = document.createElement(tag);
  made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}

function button(text: string, onClick: () => void): HTMLButtonElement {
  const made = node("button", "tb-link", text);
  made.type = "button";
  made.addEventListener("click", onClick);
  return made;
}

function link(text: string, href: string): HTMLAnchorElement {
  const made = node("a", "", text);
  made.href = href;
  return made;
}

function policyLine(origin: PolicyOrigin): HTMLElement {
  const line = node("p", "tb-meta", "Policy: ");
  if (origin.from === "file") {
    line.append(link(POLICY_FILE_PATH, origin.url), " on the default branch");
  } else {
    line.append(origin.from === "saved" ? "rules saved in this browser" : `recommended rules (no ${POLICY_FILE_PATH})`);
  }
  return line;
}

function ruleReason(rule: ViewRule, modelAsked: boolean): string {
  if (rule.state === "not-evaluated") return modelAsked ? "The decision model did not answer." : "Needs a decision model; add one in the side panel.";
  const reason = rule.reason.startsWith(`${rule.name}: `) ? rule.reason.slice(rule.name.length + 2) : rule.reason;
  return rule.evidence.length ? `${reason}: ${rule.evidence.join(", ")}` : reason;
}

function rulesList(view: TriageView): HTMLElement {
  const list = node("ul", "tb-rules");
  list.setAttribute("aria-label", "Rules");
  for (const rule of [...view.rules].sort((a, b) => ORDER[a.state] - ORDER[b.state])) {
    const item = node("li", "tb-rule");
    item.dataset.state = rule.state;
    const reason = ruleReason(rule, view.modelAsked);
    item.title = reason;
    item.append(node("span", "tb-state", STATE_NAMES[rule.state]), node("b", "", rule.name), node("span", "tb-reason", reason));
    list.append(item);
  }
  return list;
}

// Only the file is the policy the hub syncs; rules saved in the browser or the recommended ones are this browser's own.
function postedPart(posted: Posted, origin: PolicyOrigin): HTMLElement[] {
  const parts: HTMLElement[] = [node("h3", "tb-subhead", origin.from === "file" ? "The hub would post" : "This policy would post")];
  parts.push(node("p", "tb-line", `Labels: ${posted.labels.join(", ") || "none"}`));
  for (const step of posted.steps) parts.push(node("p", "tb-line", step));
  if (!posted.comment) {
    parts.push(node("p", "tb-line", "No comment"));
    return parts;
  }
  const comment = node("details", "tb-comment");
  comment.append(node("summary", "", "Comment"), node("pre", "", posted.comment));
  parts.push(comment);
  return parts;
}

function findingLink(comment: PostedCodeReview["comments"][number]): HTMLElement {
  const item = node("li", "tb-finding");
  item.append(link(findingTitle(comment), comment.url), node("span", "tb-meta", comment.line === null ? `${comment.path} · outdated` : `${comment.path}:${comment.line}`));
  return item;
}

function codeReviewPart(read: NonNullable<TriageView["codeReview"]>): HTMLElement[] {
  if ("error" in read) return [node("h3", "tb-subhead", "Code review"), node("p", "tb-warn", `Couldn't read the code review: ${read.error}`)];
  const { review } = read;
  if (!review) return [];
  const head = node("h3", "tb-subhead");
  head.append(link("Code review", review.url), ` by ${review.author}`);
  const parts: HTMLElement[] = [head];
  if (review.earlier) parts.push(node("p", "tb-meta", "For an earlier commit."));
  if (review.comments.length) {
    const list = node("ul", "tb-findings");
    list.setAttribute("aria-label", "Code review comments");
    list.append(...review.comments.map(findingLink));
    parts.push(list);
  }
  return parts;
}

export type TriageBlock = { element: HTMLElement; render(view: TriageView | undefined, run: RunState | undefined): void };

/**
 * Triage's section atop GitHub's pull request sidebar: where the policy came from, each rule's result with its
 * evidence, and, when the rules decide the verdict without the decision model, the verdict and what the policy would post.
 */
export function triageBlock(handlers: { rerun(): void; openPanel(): void }): TriageBlock {
  const element = node("section", "tb");
  element.setAttribute("aria-label", "Corbits Triage");
  element.tabIndex = -1;

  function head(view: TriageView | undefined, run: RunState | undefined): HTMLElement {
    const bar = node("div", "tb-head");
    const title = node("h2", "tb-title");
    title.innerHTML = `<svg viewBox="32 115 437 270" aria-hidden="true"><path fill="currentColor" d="${CORBITS_MARK_PATH}"/></svg>`;
    title.append("Corbits Triage");
    const { text, tone } = summaryOf(view, run);
    const verdict = node("span", "tb-verdict", text);
    verdict.dataset.tone = tone;
    bar.append(title, verdict);
    return bar;
  }

  function foot(view: TriageView | undefined, run: RunState | undefined): HTMLElement {
    const row = node("div", "tb-foot");
    const rerun = button(run?.running ? "Checking…" : "Check again", handlers.rerun);
    rerun.disabled = run?.running === true;
    row.append(rerun, button("Settings", handlers.openPanel));
    if (view) row.append(node("span", "tb-meta", `Checked ${clock(view.ranAt)}`));
    return row;
  }

  function render(view: TriageView | undefined, run: RunState | undefined) {
    const parts: HTMLElement[] = [head(view, run)];
    if (run?.error) parts.push(node("p", "tb-warn", view ? `${run.error} Showing the check from ${clock(view.ranAt)}.` : run.error));
    if (view) {
      parts.push(policyLine(view.policy), rulesList(view));
      if (view.decided) parts.push(...postedPart(view.decided, view.policy));
      else parts.push(node("p", "tb-meta", "The verdict needs the decision model, so it is not named here."));
      if (view.codeReview) parts.push(...codeReviewPart(view.codeReview));
    }
    parts.push(foot(view, run));
    element.replaceChildren(...parts);
  }

  return { element, render };
}
