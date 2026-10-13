import { citationOf, citationUrl } from "@corbits/triage-contracts";
import { Check, ChevronRight, CircleHelp, Minus, X } from "lucide-react";
import { useState } from "react";
import { checkReason, RESULT_NAMES, shownChecks } from "../summary.ts";
import type { TriageView, ViewCheck } from "../view.ts";

const MARKS: Record<ViewCheck["result"], typeof Check> = { pass: Check, fail: X, unconfirmed: CircleHelp, "needs-judge": Minus };

// Past this many, a check's evidence shows its first few and how many more.
const EVIDENCE_SHOWN = 6;

type CheckListProps = { view: TriageView; expanded?: boolean };

/** An evidence line; one citing changed lines links to them in the file at the head the run judged. */
function Evidence({ item, check, view }: { item: string; check: ViewCheck; view: TriageView }) {
  const citation = citationOf(check.output, item);
  const href = citation && citationUrl(view.pr.repo, view.headSha, citation);
  return href ? <a href={href} target="_blank" rel="noreferrer">{item}</a> : <>{item}</>;
}

function CheckRow({ check, view, expanded }: CheckListProps & { check: ViewCheck }) {
  // With room to spare, the evidence of what needs attention shows from the start.
  const [open, setOpen] = useState(expanded === true && check.result !== "pass" && check.evidence.length > 0);
  const Mark = MARKS[check.result];
  const extra = check.evidence.length - EVIDENCE_SHOWN;
  const detail = check.evidence.length > 0;

  function toggle() {
    setOpen(!open);
  }

  const head = (
    <>
      <span className="result-mark" data-result={check.result} role="img" aria-label={RESULT_NAMES[check.result]}><Mark aria-hidden="true" /></span>
      <span className="check-text">
        <span className="check-name">{check.name}</span>
        <span className="check-reason">{checkReason(check)}</span>
      </span>
      <span className="kind" title={check.kind === "model" ? "Answered by a decision model" : "Computed from GitHub data"}>{check.kind === "model" ? "model" : "rule"}</span>
    </>
  );

  return (
    <li className="check">
      {detail ? (
        <button type="button" className="check-head" aria-expanded={open} onClick={toggle}>
          {head}
          <ChevronRight className="chevron" aria-hidden="true" />
        </button>
      ) : <div className="check-head">{head}<span className="chevron" /></div>}
      {open ? (
        <div className="check-detail">
          <ul className="evidence">
            {check.evidence.slice(0, EVIDENCE_SHOWN).map((item, index) => <li key={index} title={item}><Evidence item={item} check={check} view={view} /></li>)}
            {extra > 0 ? <li className="evidence-more">and {extra} more</li> : null}
          </ul>
        </div>
      ) : null}
    </li>
  );
}

type Group = { id: "fail" | "unsure" | "pass"; title: string; checks: ViewCheck[] };

function groupsOf(view: TriageView): Group[] {
  const shown = shownChecks(view);
  const groups: Group[] = [
    { id: "fail", title: "Failing", checks: shown.filter((check) => check.result === "fail") },
    { id: "unsure", title: "Unsure", checks: shown.filter((check) => check.result === "unconfirmed" || check.result === "needs-judge") },
    { id: "pass", title: "Passed", checks: shown.filter((check) => check.result === "pass") },
  ];
  return groups.filter((group) => group.checks.length > 0);
}

function CheckGroup({ group, view, expanded }: CheckListProps & { group: Group }) {
  // Passes need no attention, so they wait behind their count.
  const [open, setOpen] = useState(group.id !== "pass");

  function toggle() {
    setOpen(!open);
  }

  return (
    <li className="check-group" data-group={group.id}>
      <button type="button" className="group-head" aria-expanded={open} onClick={toggle}>
        <ChevronRight className="chevron" aria-hidden="true" />
        <span>{group.title}</span>
        <span className="count mono">{group.checks.length}</span>
      </button>
      {open ? <ul className="checks">{group.checks.map((check) => <CheckRow key={check.check} check={check} view={view} expanded={expanded} />)}</ul> : null}
    </li>
  );
}

/** The run's rules grouped failing, unsure and passed; each opens to its evidence. */
export function CheckList({ view, expanded }: CheckListProps) {
  const groups = groupsOf(view);
  if (!groups.length) return <p className="hint">No rules ran on this pull request.</p>;
  return <ul className="check-groups">{groups.map((group) => <CheckGroup key={group.id} group={group} view={view} expanded={expanded} />)}</ul>;
}
