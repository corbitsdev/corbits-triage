import { Switch } from "@corbits/react-ui";
import type { CleanupMode } from "@corbits/triage-contracts";

type PostingToggleProps = { mode: CleanupMode; disabled: boolean; onChange: (mode: CleanupMode) => void };

/** Whether the verdict's labels and reply post without asking. */
export default function PostingToggle({ mode, disabled, onChange }: PostingToggleProps) {
  return (
    <section className="rs" aria-labelledby="rs-posting">
      <h3 id="rs-posting">Posting</h3>
      <div className="sentence">
        <span className="txt">Post the verdict without asking me<small>Labels and one reply. Never merges or closes. Off, you approve each one.</small></span>
        <Switch className="sw" checked={mode === "automated"} onCheckedChange={(on) => onChange(on ? "automated" : "human-approved")} label="Post the verdict without asking me" disabled={disabled} />
      </div>
    </section>
  );
}
