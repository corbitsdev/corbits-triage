import { Switch } from "@corbits/react-ui";
import { InfoTooltip } from "@corbits/react-ui/ui/tooltip";
import { LABEL_MAX, ruleLabel, VERDICTS, type VerdictWord } from "@corbits/triage-contracts";
import { STEPS_MAX } from "../../lib/pack-draft.ts";
import type { PolicyView } from "../../lib/use-policy-view.ts";
import RunPill from "./RunPill.tsx";

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

const VERDICT_TIP = "Triage always puts the verdict's label on the pull request and takes the other two off, so anything watching GitHub can act on it.";
const RULES_TIP = "Adds a rule label for each rule that failed, as a labels step on every verdict.";

type LabelsCardProps = {
  view: PolicyView;
  /** Whether triage writes labels on its own; undefined while the grants are unknown. */
  automatic: boolean | undefined;
  disabled: boolean;
};

/** Stable labels other tools react to through GitHub: each verdict's own label, and one per failed rule. */
export default function LabelsCard({ view, automatic, disabled }: LabelsCardProps) {
  const labelling = VERDICTS.filter((verdict) => view.ruleLabels[verdict]);
  const on = labelling.length === VERDICTS.length;
  const problem = VERDICTS.map((verdict) => view.labels[verdict].problem).find(Boolean);
  // Turning it on adds a step to every verdict, which a full verdict has no room for.
  const full = VERDICTS.filter((verdict) => view.full[verdict] && !view.ruleLabels[verdict]);

  function nameField(verdict: VerdictWord) {
    return (
      <label key={verdict} className="lbl-field">
        <span>{VERDICT_NAMES[verdict]}</span>
        <input className="val lbl" aria-label={`${VERDICT_NAMES[verdict]} label`} maxLength={LABEL_MAX} disabled={disabled} value={view.labels[verdict].name} onChange={(event) => view.setLabelName(verdict, event.target.value)} />
      </label>
    );
  }

  return (
    <section className="gcard labels-card" aria-label="Labels">
      <header><b>Labels</b><span>Stable labels other tools can react to, such as a coding agent that picks up “{view.labels.fail.name}”.</span></header>
      <div className="sentences">
        <div className="sentence rule">
          <div className="rmain">
            <div className="rline"><span className="w">Label each pull request with its verdict</span><InfoTooltip label={VERDICT_TIP} triggerLabel="About verdict labels" /></div>
            <div className="rline">{VERDICTS.map(nameField)}</div>
            {problem ? <p className="reason">Not saved yet: {problem}</p> : null}
          </div>
          <span className="model">always</span>
          <span className="rm-gap" />
        </div>
        <div className={labelling.length ? "sentence rule" : "sentence rule off"}>
          <div className="rmain">
            <div className="rline">
              <span className="w">Also label each failed rule</span>
              <code className="lbl-code">{ruleLabel("<id>")}</code>
              <InfoTooltip label={RULES_TIP} triggerLabel="About failed-rule labels" />
              {labelling.length > 0 && !on ? <span className="model">only on {labelling.map((verdict) => VERDICT_NAMES[verdict]).join(" and ")}</span> : null}
            </div>
            {!on && full.length > 0 ? <p className="reason">{full.map((verdict) => VERDICT_NAMES[verdict]).join(" and ")} already holds {STEPS_MAX} steps; remove one to label failed rules.</p> : null}
          </div>
          {labelling.length > 0 && automatic !== undefined ? <RunPill automatic={automatic} /> : null}
          <Switch className="sw" checked={on} onCheckedChange={view.setRuleLabels} label="Also label each failed rule" disabled={disabled || (!on && full.length > 0)} />
          <span className="rm-gap" />
        </div>
      </div>
    </section>
  );
}
