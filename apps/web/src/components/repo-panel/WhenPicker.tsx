import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@corbits/react-ui/ui/menu";
import type { ActionForm } from "../../lib/action-builder.ts";
import { ACTION_EVENTS, EVENT_NAMES } from "../../lib/pack-prose.ts";

type WhenPickerProps = { when: ActionForm["when"]; disabled: boolean; onChange: (when: ActionForm["when"]) => void };

/** Every event, or the pull request events that wake the action. */
export default function WhenPicker({ when, disabled, onChange }: WhenPickerProps) {
  const picked = when === "every" ? [] : when;
  const rest = ACTION_EVENTS.filter((event) => !picked.includes(event));
  return (
    <span className="pills">
      {when === "every" ? <span className="pill">Every event</span> : null}
      {picked.map((event) => (
        <span key={event} className="pill">
          {EVENT_NAMES[event]}
          <button type="button" aria-label={`Remove ${EVENT_NAMES[event]}`} disabled={disabled} onClick={() => onChange(picked.length === 1 ? "every" : picked.filter((item) => item !== event))}>×</button>
        </span>
      ))}
      <Menu>
        <MenuTrigger asChild><button type="button" className="linkish" disabled={disabled}>Add event</button></MenuTrigger>
        <MenuContent align="start">
          {when === "every" ? null : <><MenuItem onSelect={() => onChange("every")}>Every event</MenuItem><MenuSeparator /></>}
          {rest.map((event) => <MenuItem key={event} onSelect={() => onChange([...picked, event])}>{EVENT_NAMES[event]}</MenuItem>)}
        </MenuContent>
      </Menu>
    </span>
  );
}
