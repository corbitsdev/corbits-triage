import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import type { CheckPack, PolicyFileStatus, PolicyPatchChange, RepoSource } from "@corbits/triage-contracts";
import { counted } from "../../lib/plural.ts";
import { usePatchPreview, usePolicyPatch, type PatchPreview } from "../../lib/policy-file.ts";
import { changeSentences, touchedIds } from "../../lib/policy-patch.ts";
import PolicyRules from "../repo-panel/PolicyRules.tsx";

type ChangeTrayProps = { repo: string; source: RepoSource; file: PolicyFileStatus; pack: CheckPack; changes: readonly PolicyPatchChange[]; disabled: boolean; onOpened: () => void };

function Preview({ preview, path, source }: { preview: PatchPreview; path: string; source: RepoSource }) {
  const { read } = preview;
  return (
    <>
      <p className="lead">After it merges, the policy reads:</p>
      {read.kind === "file" ? <PolicyRules pack={read.pack} source={source} /> : <p className="reason">{read.reason}</p>}
      <details className="file-pair">
        <summary><code>{path}</code> before and after</summary>
        <div><span>Before</span><pre className="file-text">{preview.before}</pre></div>
        <div><span>After</span><pre className="file-text">{preview.after}</pre></div>
      </details>
    </>
  );
}

/** The batch in sentences, then what the policy reads after it and the file itself; one button opens the pull request. */
export default function ChangeTray({ repo, source, file, pack, changes, disabled, onOpened }: ChangeTrayProps) {
  const preview = usePatchPreview(repo, source, changes);
  const open = usePolicyPatch(repo, source);
  const count = touchedIds(changes).length;
  const error = preview.error ?? open.error;
  // With a policy pull request open, the batch is applied to its branch, which may already hold it.
  const unchanged = preview.data !== undefined && preview.data.before === preview.data.after;

  return (
    <aside className="tray" aria-labelledby="tray-title">
      <header>
        <b id="tray-title">{counted(count, "change", "changes")}. Open a pull request to apply {count === 1 ? "it" : "them"}.</b>
      </header>
      <ul>{changeSentences(pack, changes).map((sentence) => <li key={sentence}>{sentence}</li>)}</ul>
      {preview.data ? <Preview preview={preview.data} path={file.path} source={source} /> : null}
      {unchanged ? <p className="help">The open pull request already makes these changes.</p> : null}
      {error ? <p role="alert" className="error">{errorText(error)}</p> : null}
      <div className="acts">
        <Button type="button" size="sm" disabled={disabled || !preview.isSuccess || unchanged || open.isPending} onClick={() => open.mutate(changes, { onSuccess: onOpened })}>Open a pull request</Button>
      </div>
    </aside>
  );
}
