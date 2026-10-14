import type { ReactNode } from "react";
import { Switch } from "@corbits/react-ui";
import { InfoTooltip } from "@corbits/react-ui/ui/tooltip";

type RuleRowProps = {
  id: string;
  label: string;
  on: boolean;
  words: ReactNode;
  tip: string;
  model?: boolean;
  stat?: string | null;
  more?: ReactNode;
  reason?: string | null;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  onRemove?: () => void;
};

export default function RuleRow({ id, label, on, words, tip, model, stat, more, reason, disabled, onToggle, onRemove }: RuleRowProps) {
  return (
    <div className={`sentence rule${on ? "" : " off"}${reason ? " invalid" : ""}`} id={`rp-rule-${id}`}>
      <div className="rmain">
        <div className="rline"><span className="w">{words}</span><InfoTooltip label={tip} triggerLabel={`About ${label}`} />{model ? <span className="model">decision model</span> : null}</div>
        {on ? more : null}
        {reason ? <p className="reason">Not saved yet: {reason}</p> : null}
      </div>
      <span className="stat">{on && stat ? stat : null}</span>
      <Switch className="sw" checked={on} onCheckedChange={onToggle} label={label} disabled={disabled} />
      {onRemove
        ? <button type="button" className="rm" aria-label="Remove this rule" title="Remove this rule" disabled={disabled} onClick={onRemove}>×</button>
        : <span className="rm-gap" />}
    </div>
  );
}
