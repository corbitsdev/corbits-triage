import { POLICY_EVENTS, type PolicyEvent } from "@corbits/triage-contracts";
import { EVENT_NAMES } from "../../lib/pack-prose.ts";

type WhenPickerProps = { when: PolicyEvent[]; disabled: boolean; onChange: (when: PolicyEvent[]) => void };

/** The pull request events that wake the policy's actions; at least one stays on. */
export default function WhenPicker({ when, disabled, onChange }: WhenPickerProps) {
  function toggle(event: PolicyEvent) {
    onChange(POLICY_EVENTS.filter((item) => (item === event ? !when.includes(item) : when.includes(item))));
  }

  return (
    <span className="pills">
      {POLICY_EVENTS.map((event) => {
        const on = when.includes(event);
        return <button key={event} type="button" className="pill" aria-pressed={on} disabled={disabled || (on && when.length === 1)} onClick={() => toggle(event)}>{EVENT_NAMES[event]}</button>;
      })}
    </span>
  );
}
