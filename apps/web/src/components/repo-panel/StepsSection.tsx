import { Link } from "react-router-dom";
import { Badge, Textarea } from "@corbits/react-ui";
import { alwaysHeld, VERDICTS, type ActionKind, type PeopleTarget, type ReviewTarget, type Step, type StepKind, type VerdictWord } from "@corbits/triage-contracts";
import { FOR_NAMES, forChoice, freshStep, STEP_DO_NAMES, STEP_DOS, withFor, type ForChoice } from "../../lib/policy-view.ts";
import type { PolicyView, StepRow } from "../../lib/use-policy-view.ts";
import TokenList from "./TokenList.tsx";

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

const RECIPIENTS: Array<{ value: PeopleTarget["to"]; label: string }> = [
  { value: "codeowners", label: "code owners" },
  { value: "users", label: "people" },
  { value: "teams", label: "teams" },
  { value: "author", label: "the author" },
];

function whoOf(to: PeopleTarget["to"]): PeopleTarget {
  switch (to) {
    case "users":
      return { to, users: [] };
    case "teams":
      return { to, teams: [] };
    default:
      return { to };
  }
}

type StepsSectionProps = {
  view: PolicyView;
  /** Whether the pr-triage role holds the grant for `kind`; undefined while the grants are unknown. */
  automatic: ((kind: ActionKind) => boolean) | undefined;
  disabled: boolean;
};

/** What runs on each verdict, as steps; each says whether it runs on its own or waits for you. */
export default function StepsSection({ view, automatic, disabled }: StepsSectionProps) {
  function pill(verdict: VerdictWord, step: Step) {
    if (!automatic || step.do === "nothing") return <span />;
    const alone = automatic(step.do) && !alwaysHeld(verdict, step.do);
    return <Badge tone={alone ? "success" : "warning"} className="pill">{alone ? "automatic" : "waits for you"}</Badge>;
  }

  function people(step: Extract<Step, { do: "request-review" | "assign" }>, onChange: (who: PeopleTarget) => void) {
    const who = step.target;
    const options = RECIPIENTS.filter((option) => option.value !== "author" || step.do === "assign");
    return (
      <span className="tokens">
        <select className="val q" aria-label={step.do === "assign" ? "Assign to" : "Request review from"} disabled={disabled} value={who.to} onChange={(event) => onChange(whoOf(event.target.value as PeopleTarget["to"]))}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {who.to === "users" ? <TokenList values={who.users} noun="person" placeholder="login" disabled={disabled} onChange={(users) => onChange({ to: "users", users })} /> : null}
        {who.to === "teams" ? <TokenList values={who.teams} noun="team" placeholder="@org/team" mono disabled={disabled} onChange={(teams) => onChange({ to: "teams", teams })} /> : null}
      </span>
    );
  }

  function inline(step: Step, change: (next: Step) => void) {
    if (step.do !== "labels" || step.target.from !== "list") return null;
    return <TokenList values={step.target.labels} noun="label" placeholder="needs-fix" mono disabled={disabled} onChange={(labels) => change({ ...step, target: { from: "list", labels } })} />;
  }

  function audience(step: Step, change: (next: Step) => void) {
    if (typeof step.for !== "object") return null;
    if ("team" in step.for) return <input className="val lbl" aria-label="GitHub team" placeholder="org/team" disabled={disabled} value={step.for.team} onChange={(event) => change({ ...step, for: { team: event.target.value } })} />;
    return <TokenList values={step.for.users} noun="person" placeholder="login" disabled={disabled} onChange={(users) => change({ ...step, for: { users } })} />;
  }

  function under(step: Step, change: (next: Step) => void) {
    switch (step.do) {
      case "comment":
        return <Textarea className="val body" rows={1} autoResize aria-label="Comment" placeholder="Comment" disabled={disabled} value={step.target.body} onChange={(event) => change({ ...step, target: { body: event.target.value } })} />;
      case "request-review":
        return people(step, (who) => change({ ...step, target: who as ReviewTarget }));
      case "assign":
        return people(step, (who) => change({ ...step, target: who }));
      default:
        return null;
    }
  }

  function doOption(choice: StepKind) {
    return <option key={choice} value={choice} disabled={choice === "nothing"}>{STEP_DO_NAMES[choice]}</option>;
  }

  function stepRow(verdict: VerdictWord, { key, index, step, problem }: StepRow) {
    function change(next: Step) {
      view.setStep(verdict, index, next);
    }
    const below = under(step, change);
    const choices: StepKind[] = step.do === "nothing" ? [...STEP_DOS, "nothing"] : [...STEP_DOS];
    return (
      <div key={key} className={problem ? "step invalid" : "step"}>
        <span className="sline">
          <select className="val" aria-label="Do" disabled={disabled} value={step.do} onChange={(event) => change(freshStep(step, event.target.value as StepKind))}>
            {choices.map(doOption)}
          </select>
          {inline(step, change)}
          <span className="for-w">for</span>
          <select className="val q" aria-label="For" disabled={disabled} value={forChoice(step)} onChange={(event) => change(withFor(step, event.target.value as ForChoice))}>
            {Object.entries(FOR_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
          {audience(step, change)}
        </span>
        {pill(verdict, step)}
        <button type="button" className="rm" aria-label="Remove this step" title="Remove this step" disabled={disabled} onClick={() => view.removeStep(verdict, index)}>×</button>
        {below ? <div className="sub">{below}</div> : null}
        {problem ? <p className="reason sub">Not saved yet: {problem}</p> : null}
      </div>
    );
  }

  function verdictRow(verdict: VerdictWord) {
    const rows = view.steps[verdict];
    return (
      <div key={verdict} className="then" id={`rp-list-${verdict}`}>
        <div className="vh"><b className="vw">{VERDICT_NAMES[verdict]}</b></div>
        <div className="steps">
          {rows.length ? rows.map((row) => stepRow(verdict, row)) : <p className="none">{view.handoffLabels ? "Only the labels below." : "Nothing happens."}</p>}
          <button type="button" className="linkish quiet step-add" disabled={disabled} onClick={() => view.addStep(verdict)}>+ Add a step</button>
        </div>
      </div>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-then" id="rp-actions">
      <h3 id="rs-then">Then</h3>
      <p className="help">A failed rule decides Fail; otherwise the model decides, and Unsure below 70% sure.</p>
      <div className="then-t">{VERDICTS.map(verdictRow)}</div>
      <p className="help">Automatic when Triage holds the action in <Link to="/settings/access">Settings → Access</Link>; the rest wait for you in the inbox.</p>
    </section>
  );
}
