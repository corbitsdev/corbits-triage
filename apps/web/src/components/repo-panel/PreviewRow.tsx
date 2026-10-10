import { useState, type FormEvent } from "react";
import type { CheckPack } from "@corbits/triage-contracts";
import { errorText } from "../../lib/error-text.ts";
import { previewPull, type PullPreview } from "../../lib/hub-api.ts";
import { createHubTransport } from "../../lib/hub-transport.ts";
import { useOpenPulls } from "../../lib/open-pulls.ts";
import type { RepoDraft } from "../../lib/pack-draft.ts";
import { usePortal } from "../../lib/portal.tsx";
import { previewProse, type BranchLine } from "../../lib/preview-prose.ts";

type Previewed = { preview: PullPreview; pack: CheckPack };

function Outcome({ line }: { line: BranchLine }) {
  return <span> <b>{line.branch}:</b> {line.dos}</span>;
}

function Result({ preview, pack }: Previewed) {
  const prose = previewProse(preview, pack);
  return (
    <div className="preview">
      <p className="prose">
        <b>#{preview.number}</b> at <code>{preview.headSha.slice(0, 7)}</code>.
        {prose.checks.map((line) => <span key={line.result}> {line.label}: {line.names.join(", ")}.</span>)}
      </p>
      {prose.degraded ? <p className="note">{prose.degraded}</p> : null}
      {prose.actions.map((action) => (
        <p key={action.id} className="prose">
          <b>{action.label}</b>{" "}
          {action.status === "skipped" ? `is skipped. ${action.reason}` : null}
          {action.status === "decided" ? <>{action.branch.reason}<Outcome line={action.branch} /></> : null}
          {action.status === "waits-on-judge" ? <>waits on the judge.{action.branches.map((line) => <Outcome key={line.branch} line={line} />)}</> : null}
        </p>
      ))}
      {prose.notWoken ? <p className="prose">{prose.notWoken}</p> : null}
      {prose.comment ? <><p className="prose"><b>Comment to the author</b></p><blockquote className="feedback">{prose.comment}</blockquote></> : null}
    </div>
  );
}

/** Runs the draft, unsaved edits included, against one open pull request; nothing is written, so read-only sessions can preview too. */
export default function PreviewRow({ repo, draft }: { repo: string; draft: RepoDraft }) {
  const { snapshot } = usePortal();
  const tenantId = snapshot?.workspace.tenantId;
  const openPulls = useOpenPulls();
  const listed = openPulls.data?.repos.find((row) => row.repo === repo);
  const pulls = listed?.error === undefined ? listed?.prs ?? [] : [];
  const [picked, setPicked] = useState("");
  const [previewed, setPreviewed] = useState<Previewed | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  // A typed number or an earlier pick only holds while it is still one of the listed pulls.
  const number = pulls.length ? (pulls.find((pr) => String(pr.number) === picked) ?? pulls[0]!).number : Number(picked);

  async function preview(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (tenantId === undefined) return;
    const { pack, policy } = draft;
    setRunning(true);
    setError("");
    try {
      setPreviewed({ preview: await previewPull(createHubTransport(), tenantId, { repo, number, pack, roles: policy.roles }), pack });
    } catch (cause) {
      setPreviewed(null);
      setError(`Could not preview. ${errorText(cause)}`);
    } finally {
      setRunning(false);
    }
  }

  function renderPicker() {
    if (openPulls.isPending) return <select className="val w" aria-label="Pull request" disabled><option>Loading pull requests…</option></select>;
    if (pulls.length === 0) return <input className="val" type="number" min={1} aria-label="Pull request number" placeholder="#" value={picked} onChange={(e) => setPicked(e.target.value)} />;
    return (
      <select className="val w" aria-label="Pull request" value={number} onChange={(e) => setPicked(e.target.value)}>
        {pulls.map((pr) => <option key={pr.number} value={pr.number}>#{pr.number} {pr.title}</option>)}
      </select>
    );
  }

  return (
    <section className="rs" aria-labelledby="rs-preview">
      <h3 id="rs-preview">Preview</h3>
      <form className="sentence" onSubmit={(event) => void preview(event)}>
        <span className="txt">Run this draft on a pull request<small>Unsaved edits included. Nothing is written to GitHub and the judge is not run.</small></span>
        {renderPicker()}
        <button type="submit" className="btn btn-sm" disabled={tenantId === undefined || running || !Number.isInteger(number) || number < 1}>{running ? "Previewing…" : "Preview"}</button>
      </form>
      {error ? <p role="alert" className="error">{error}</p> : null}
      {previewed ? <Result {...previewed} /> : null}
    </section>
  );
}
