import type { PostedCodeReview } from "@corbits/github-reads";
import { CORBITS_MARK_PATH } from "@corbits/react-ui";
import { findingTitle, POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { clock } from "../clock.ts";
import type { RunState } from "../storage.ts";
import type { RuleState, TriageView, ViewRule } from "../view.ts";
import { summaryOf } from "./chip.ts";

const POLICY_GUIDE_URL = "https://github.com/corbitsdev/corbits-triage/blob/main/docs/Corbits%20Triage%20User%20Manual/Corbits%20Triage%20User%20Manual.md#writing-the-file";

const STATE_NAMES: Record<RuleState, string> = { pass: "Pass", fail: "Fail", waiting: "Waiting", "not-run": "Not run here" };
const ORDER: Record<RuleState, number> = { fail: 0, waiting: 1, "not-run": 2, pass: 3 };

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

function noPolicyGuide(): HTMLElement {
  const guide = node("p", "tb-meta", `This repository has no ${POLICY_FILE_PATH} on its default branch, so there is nothing to check. `);
  guide.append(link("How to write one", POLICY_GUIDE_URL), ".");
  return guide;
}

function policyLine(policy: TriageView["policy"]): HTMLElement {
  if (!policy) return noPolicyGuide();
  const line = node("p", "tb-meta", "Policy: ");
  line.append(link(policy.path, policy.url), " on the default branch");
  return line;
}

function ruleReason(rule: ViewRule): string {
  const reason = rule.reason.startsWith(`${rule.name}: `) ? rule.reason.slice(rule.name.length + 2) : rule.reason;
  return rule.evidence.length ? `${reason}: ${rule.evidence.join(", ")}` : reason;
}

function rulesList(view: TriageView): HTMLElement {
  const list = node("ul", "tb-rules");
  list.setAttribute("aria-label", "Checks");
  for (const rule of [...view.rules].sort((a, b) => ORDER[a.state] - ORDER[b.state])) {
    const item = node("li", "tb-rule");
    item.dataset.state = rule.state;
    const reason = ruleReason(rule);
    item.title = reason;
    item.append(node("span", "tb-state", STATE_NAMES[rule.state]), node("b", "", rule.name), node("span", "tb-reason", reason));
    list.append(item);
  }
  return list;
}

function findingLink(comment: PostedCodeReview["comments"][number]): HTMLElement {
  const item = node("li", "tb-finding");
  item.append(link(findingTitle(comment), comment.url), node("span", "tb-meta", comment.line === null ? `${comment.path} · outdated` : `${comment.path}:${comment.line}`));
  return item;
}

function codeReviewPart(read: TriageView["codeReview"]): HTMLElement[] {
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
 * Triage's section atop GitHub's pull request sidebar: the policy file, the score of the checks run here and each
 * check's result with its evidence.
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
      parts.push(policyLine(view.policy));
      if (view.paused !== undefined) parts.push(node("p", "tb-meta", `Paused: this pull request has the ${view.paused} label, so Triage leaves it alone.`));
      else if (view.policy) parts.push(rulesList(view));
      parts.push(...codeReviewPart(view.codeReview));
    }
    parts.push(foot(view, run));
    element.replaceChildren(...parts);
  }

  return { element, render };
}
