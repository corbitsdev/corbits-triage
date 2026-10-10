import { Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger } from "@corbits/react-ui/ui/menu";
import type { Action, CheckPack, Do } from "@corbits/triage-contracts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { BRANCH_NAMES, doText, whenText, type Branch } from "../../lib/pack-prose.ts";
import type { RepoPack } from "../../lib/repo-pack.ts";
import CheckName from "./CheckName.tsx";
import Joined from "./Joined.tsx";

/** Ends with a full stop unless a quoted comment already ends the sentence. */
function sentence(text: string): string {
  return /[.!?]”$/.test(text) ? text : `${text}.`;
}

type ActionRowProps = {
  action: Action;
  index: number;
  count: number;
  draft: RepoDraft;
  saved: CheckPack;
  disabled: boolean;
  edit: RepoPack["edit"];
  /** Why the draft cannot be saved, when this action is the reason. */
  reason?: string;
  onEdit: () => void;
  onRemove: () => void;
  onMove: (to: number) => void;
};

/** One action as a sentence: When, Checks, then the Dos of each outcome. */
export default function ActionRow({ action, index, count, draft, saved, disabled, edit, reason, onEdit, onRemove, onMove }: ActionRowProps) {
  const branches = Object.entries(action.branches) as Array<[Branch, Do[]]>;
  const checks = action.checks.map((id) => ({ key: id, node: <CheckName id={id} draft={draft} saved={saved} disabled={disabled} edit={edit} /> }));
  return (
    <div className={reason ? "act invalid" : "act"} id={`rp-action-${action.id}`}>
      <div className="sentence">
        <p className="prose">
          <b>{whenText(action.when)}</b>
          {checks.length ? <>, check <Joined items={checks} joiner="and" /></> : null}.
          {branches.filter(([, dos]) => dos.length > 0).map(([branch, dos]) => (
            <span key={branch} className="outcome"> <b>{BRANCH_NAMES[branch]}:</b> {sentence(dos.map(doText).join(", then "))}</span>
          ))}
        </p>
        <button type="button" className="btn btn-quiet btn-sm" disabled={disabled} onClick={onEdit}>Edit</button>
        <Menu>
          <MenuTrigger asChild><button type="button" className="btn btn-quiet btn-sm icon" aria-label={`More for ${action.id}`} disabled={disabled}>⋯</button></MenuTrigger>
          <MenuContent align="end">
            <MenuItem disabled={index === 0} onSelect={() => onMove(index - 1)}>Move up</MenuItem>
            <MenuItem disabled={index === count - 1} onSelect={() => onMove(index + 1)}>Move down</MenuItem>
            <MenuSeparator />
            <MenuItem onSelect={onRemove}>Remove</MenuItem>
          </MenuContent>
        </Menu>
      </div>
      {reason ? <p className="reason">{reason}</p> : null}
    </div>
  );
}
