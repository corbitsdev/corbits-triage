import { Link } from "react-router-dom";
import { Badge, Textarea } from "@corbits/react-ui";
import { alwaysHeld, VERDICTS, type ActionKind, type PeopleTarget, type ReviewTarget, type VerdictWord } from "@corbits/triage-contracts";
import { triageRunsAlone } from "../../lib/automation-grid.ts";
import { FOR_NAMES, freshStep, STEP_DO_NAMES, STEP_DOS, type Step, type StepDo } from "../../lib/policy-view.ts";
import { useGrants, useRoles } from "../../lib/tenant-entities.ts";
import type { PolicyView, StepRow } from "../../lib/use-policy-view.ts";
import TokenList from "./TokenList.tsx";

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

/** The Do kind each step writes, whose grant decides whether it runs on its own. */
const KINDS: Record<Exclude<StepDo, "merge"> | "agent", ActionKind> = {
  approve: "approve",
  close: "close",
  comment: "comment",
  "request-changes": "request-changes",
  "request-review": "request-review",
  assign: "assign",
  labels: "labels",
  agent: "agent",
};

const RECIPIENTS: Array<{ value: PeopleTarget["to"]; label: string }> = [
  { value: "codeowners", label: "code owners" },
  { value: "users", label: "people" },
  { value: "teams", label: "teams" },
  { value: "role", label: "a role" },
  { value: "author", label: "the author" },
];

function whoOf(to: PeopleTarget["to"], role: string | undefined): PeopleTarget {
  switch (to) {
    case "users":
      return { to, users: [] };
    case "teams":
      return { to, teams: [] };
    case "role":
      return { to, role: role ?? "" };
    default:
      return { to };
  }
}

function forValue(step: Step): keyof typeof FOR_NAMES {
  if (typeof step.for === "string") return step.for;
  return "team" in step.for ? "team" : "users";
}

type StepsSectionProps = { repo: string; view: PolicyView; disabled: boolean };

/** What runs on each verdict, as steps; each says whether it runs on its own or waits for you. */
export default function StepsSection({ repo, view, disabled }: StepsSectionProps) {
  const grants = useGrants();
  const roles = useRoles();
  const known = ![grants, roles].some((section) => section.loading || section.unavailable || section.denied);

  function pill(verdict: VerdictWord, step: Step) {
    if (!known || step.do === "merge") return <span />;
    const kind = KINDS[step.do];
    const automatic = triageRunsAlone(roles.rows, grants.rows, kind, repo) && !alwaysHeld(verdict, kind);
    return <Badge tone={automatic ? "success" : "warning"} className="pill">{automatic ? "automatic" : "waits for you"}</Badge>;
  }

  function people(step: Extract<Step, { do: "request-review" | "assign" }>, onChange: (who: PeopleTarget) => void) {
    const who = step.who;
    const options = RECIPIENTS.filter((option) => (option.value !== "author" || step.do === "assign") && (option.value !== "role" || who.to === "role"));
    return (
      <span className="tokens">
        <select className="val q" aria-label={step.do === "assign" ? "Assign to" : "Request review from"} disabled={disabled} value={who.to} onChange={(event) => onChange(whoOf(event.target.value as PeopleTarget["to"], who.to === "role" ? who.role : undefined))}>
          {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        {who.to === "users" ? <TokenList values={who.users} noun="person" placeholder="login" disabled={disabled} onChange={(users) => onChange({ to: "users", users })} /> : null}
        {who.to === "teams" ? <TokenList values={who.teams} noun="team" placeholder="@org/team" mono disabled={disabled} onChange={(teams) => onChange({ to: "teams", teams })} /> : null}
        {who.to === "role" ? <span className="glob">{who.role}</span> : null}
      </span>
    );
  }

  function inline(step: Step, change: (next: Step) => void) {
    if (step.do !== "labels") return null;
    const labels = step.labels;
    if (labels.from !== "list") return <span className="for-w">by {labels.from}</span>;
    return <TokenList values={labels.labels} noun="label" placeholder="needs-fix" mono disabled={disabled} onChange={(next) => change({ ...step, labels: { from: "list", labels: next } })} />;
  }

  function under(step: Step, change: (next: Step) => void) {
    switch (step.do) {
      case "comment":
        return <Textarea className="val body" rows={1} autoResize aria-label="Comment" placeholder="Comment" disabled={disabled} value={step.body} onChange={(event) => change({ ...step, body: event.target.value })} />;
      case "request-review":
        return people(step, (who) => change({ ...step, who: who as ReviewTarget }));
      case "assign":
        return people(step, (who) => change({ ...step, who }));
      default:
        return null;
    }
  }

  /** Merge waits on the contract; an agent step is kept as stored but no longer offered. */
  function doOption(choice: StepDo | "agent") {
    const later = choice === "merge" && !view.stores.merge;
    return <option key={choice} value={choice} disabled={later || choice === "agent"} title={later ? view.notYet : undefined}>{STEP_DO_NAMES[choice]}</option>;
  }

  function stepRow(verdict: VerdictWord, { key, step, problem }: StepRow, index: number) {
    function change(next: Step) {
      view.setStep(verdict, index, next);
    }
    const below = under(step, change);
    const choices = step.do === "agent" ? [...STEP_DOS, "agent" as const] : STEP_DOS;
    return (
      <div key={key} className={problem ? "step invalid" : "step"}>
        <span className="sline">
          <select className="val" aria-label="Do" disabled={disabled} value={step.do} onChange={(event) => change(freshStep(step, event.target.value as StepDo))}>
            {choices.map(doOption)}
          </select>
          {inline(step, change)}
          <span className="for-w">for</span>
          <select className="val q" aria-label="For" disabled={disabled || !view.stores.for} title={view.stores.for ? undefined : view.notYet} value={forValue(step)}>
            {Object.entries(FOR_NAMES).map(([value, name]) => <option key={value} value={value}>{name}</option>)}
          </select>
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
          {rows.length ? rows.map((row, index) => stepRow(verdict, row, index)) : <p className="none">Nothing happens.</p>}
          <button type="button" className="linkish quiet step-add" disabled={disabled} onClick={() => view.addStep(verdict)}>+ Add a step</button>
        </div>
      </div>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-then" id="rp-actions">
      <h3 id="rs-then">Then</h3>
      <p className="help">A failed rule decides Fail; otherwise the model decides, and Unsure below 70% sure.</p>
      <div className="then-t">
        {VERDICTS.map(verdictRow)}
      </div>
      <p className="help">Automatic when Triage holds the action in <Link to="/settings/access">Settings → Access</Link>; the rest wait for you in the inbox.</p>
    </section>
  );
}
