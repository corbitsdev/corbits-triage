import { Switch } from "@corbits/react-ui";
import { InfoTooltip } from "@corbits/react-ui/ui/tooltip";
import { ruleLabel, VERDICTS, type VerdictWord } from "@corbits/triage-contracts";
import type { PolicyView } from "../../lib/use-policy-view.ts";
import RunPill from "./RunPill.tsx";

const VERDICT_NAMES: Record<VerdictWord, string> = { pass: "Pass", fail: "Fail", unsure: "Unsure" };

const TIP = "Adds the verdict's label, and a rule label for each failed rule. Triage writes them; anything watching GitHub can act on them.";

type LabelsCardProps = {
  view: PolicyView;
  /** Whether triage writes labels on its own; undefined while the grants are unknown. */
  automatic: boolean | undefined;
  disabled: boolean;
};

/** Stable labels other tools react to through GitHub: each verdict's own label, and one per failed rule. */
export default function LabelsCard({ view, automatic, disabled }: LabelsCardProps) {
  const labelled = VERDICTS.filter((verdict) => view.labels[verdict] !== null);
  const on = labelled.length === VERDICTS.length;
  const fail = view.labels.fail?.name;

  function nameField(verdict: VerdictWord) {
    const label = view.labels[verdict];
    if (!label) return null;
    return (
      <label key={verdict} className="lbl-field">
        <span>{VERDICT_NAMES[verdict]}</span>
        <input className="val lbl" aria-label={`${VERDICT_NAMES[verdict]} label`} disabled={disabled} value={label.name} onChange={(event) => view.setLabelName(verdict, event.target.value)} />
      </label>
    );
  }

  const problem = VERDICTS.map((verdict) => view.labels[verdict]?.problem).find(Boolean);
  return (
    <section className="gcard labels-card" aria-label="Labels">
      <header><b>Labels</b><span>Stable labels other tools can react to, such as a coding agent that picks up {fail ? `“${fail}”` : "a verdict's label"}.</span></header>
      <div className="sentences">
        <div className={labelled.length ? "sentence rule" : "sentence rule off"}>
          <div className="rmain">
            <div className="rline">
              <span className="w">Label with the verdict and each failed rule</span>
              <InfoTooltip label={TIP} triggerLabel="About labels" />
              {labelled.length > 0 && !on ? <span className="model">only on {labelled.map((verdict) => VERDICT_NAMES[verdict]).join(" and ")}</span> : null}
            </div>
            {labelled.length ? <div className="rline">{VERDICTS.map(nameField)}<code className="lbl-code">{ruleLabel("<id>")}</code></div> : null}
            {problem ? <p className="reason">Not saved yet: {problem}</p> : null}
          </div>
          {labelled.length > 0 && automatic !== undefined ? <RunPill automatic={automatic} /> : null}
          <Switch className="sw" checked={on} onCheckedChange={view.setHandoffLabels} label="Label with the verdict and each failed rule" disabled={disabled} />
          <span className="rm-gap" />
        </div>
      </div>
    </section>
  );
}
