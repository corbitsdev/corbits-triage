import { Badge, Switch } from "@corbits/react-ui";
import { InfoTooltip } from "@corbits/react-ui/ui/tooltip";
import { ruleLabel, VERDICTS, verdictLabel } from "@corbits/triage-contracts";

const TIP = "Adds the verdict's label, and a rule: <id> label for each failed rule. Triage writes them; anything watching GitHub can act on them.";

type LabelsCardProps = {
  on: boolean;
  /** Whether triage writes labels on its own; undefined while the grants are unknown. */
  automatic: boolean | undefined;
  disabled: boolean;
  onToggle: (on: boolean) => void;
};

/** Stable labels other tools react to through GitHub: one labels step per verdict for the verdict, one for the failed rules. */
export default function LabelsCard({ on, automatic, disabled, onToggle }: LabelsCardProps) {
  return (
    <section className="gcard labels-card" aria-label="Labels">
      <header><b>Labels</b><span>Stable labels other tools can react to, such as a coding agent that fixes needs-fix.</span></header>
      <div className="sentences">
        <div className={on ? "sentence rule" : "sentence rule off"}>
          <div className="rmain">
            <div className="rline"><span className="w">Label with the verdict and each failed rule</span><InfoTooltip label={TIP} triggerLabel="About labels" /></div>
            <div className="rline">
              {VERDICTS.map((verdict) => <code key={verdict} className="glob">{verdictLabel(verdict)}</code>)}
              <code className="lbl-code">{ruleLabel("<id>")}</code>
            </div>
          </div>
          {on && automatic !== undefined ? <Badge tone={automatic ? "success" : "warning"} className="pill">{automatic ? "automatic" : "waits for you"}</Badge> : null}
          <Switch className="sw" checked={on} onCheckedChange={onToggle} label="Label with the verdict and each failed rule" disabled={disabled} />
          <span className="rm-gap" />
        </div>
      </div>
    </section>
  );
}
