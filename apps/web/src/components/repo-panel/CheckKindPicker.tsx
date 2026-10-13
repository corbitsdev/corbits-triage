import { Button } from "@corbits/react-ui";
import { CHECK_KINDS, type CheckKind } from "../../lib/pack-prose.ts";
import EvalBadge from "./EvalBadge.tsx";

type CheckKindPickerProps = { disabled: boolean; onPick: (kind: CheckKind) => void; onCancel: () => void };

/** The rule kinds and model shapes a new check can take. */
export default function CheckKindPicker({ disabled, onPick, onCancel }: CheckKindPickerProps) {
  return (
    <div className="gallery" role="group" aria-label="New rule">
      {CHECK_KINDS.map((kind) => (
        <div key={kind.title} className="gallery-row">
          <span><b>{kind.title}</b> {kind.line}</span>
          <EvalBadge evaluation={kind.evaluation} />
          <Button type="button" variant="outline" size="sm" aria-label={`Use ${kind.title}`} disabled={disabled} onClick={() => onPick(kind)}>Use</Button>
        </div>
      ))}
      <div className="pfoot"><span /><button type="button" className="linkish" onClick={onCancel}>Cancel</button></div>
    </div>
  );
}
