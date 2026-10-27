import { useId, useState } from "react";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import type { MergeRisk, PolicyExported, PolicyFileStatus, PolicyPushed, RepoSource } from "@corbits/triage-contracts";
import { usePolicyEditActions, usePolicyPushAccess } from "../../lib/policy-file.ts";
import { ExternalIcon } from "../inbox-icons.tsx";
import { MergeCaution } from "./MergeCaution.tsx";
import { HOST_NAME } from "./PolicyStart.tsx";

type Save = "pull" | "push";

/** A save waiting on the caution, with what the edited policy lets in. */
type Held = { save: Save; risks: MergeRisk[] };

type PolicyEditorProps = { repo: string; source: RepoSource; file: PolicyFileStatus & { text: string }; onDone: () => void };

/**
 * The policy file's text, edited and saved through a pull request or a push to the default branch. Each save checks
 * the text as triage would read it first; one that lets Triage approve or merge something risky on its own waits for
 * the caution to be read.
 */
export default function PolicyEditor({ repo, source, file, onDone }: PolicyEditorProps) {
  const [text, setText] = useState(file.text);
  const [problem, setProblem] = useState("");
  const [held, setHeld] = useState<Held | null>(null);
  const [saved, setSaved] = useState<PolicyExported | PolicyPushed | null>(null);
  const { preview, propose, push } = usePolicyEditActions(repo, source);
  const access = usePolicyPushAccess(repo, source, true);
  const textId = useId();
  const busy = preview.isPending || propose.isPending || push.isPending;
  const error = preview.error ?? propose.error ?? push.error;
  const branch = access.data?.branch;
  const host = HOST_NAME[source];

  function write(save: Save) {
    setHeld(null);
    const edit = { text, sha: file.sha };
    if (save === "push") push.mutate(edit, { onSuccess: setSaved });
    else propose.mutate(edit, { onSuccess: setSaved });
  }

  async function check(save: Save) {
    setProblem("");
    let read: Awaited<ReturnType<typeof preview.mutateAsync>>;
    try {
      read = await preview.mutateAsync(text);
    } catch {
      // The check's own error shows below the editor.
      return;
    }
    if (read.kind === "invalid") {
      setProblem(read.reason);
      return;
    }
    if (source === "github" && read.mergeRisks.length > 0) {
      setHeld({ save, risks: read.mergeRisks });
      return;
    }
    write(save);
  }

  function edited(next: string) {
    setText(next);
    setHeld(null);
    setProblem("");
  }

  function saveWords(save: Save): string {
    return save === "push" ? `Push to ${branch ?? "the default branch"}` : "Create pull request";
  }

  if (saved) {
    return (
      <section className="move" aria-labelledby="edit-title">
        <header><b id="edit-title">{saved.status === "pushed" ? `Pushed to ${branch ?? "the default branch"}` : `Pull request #${saved.number} opened`}</b></header>
        <div className="acts">
          {saved.status === "opened" ? <Button asChild variant="outline" size="sm"><a href={saved.url} target="_blank" rel="noreferrer">Review on {host} <ExternalIcon /></a></Button> : null}
          <Button type="button" variant="ghost" size="sm" onClick={onDone}>Done</Button>
        </div>
      </section>
    );
  }

  return (
    <section className="move" aria-labelledby="edit-title">
      <header>
        <b id="edit-title"><label htmlFor={textId}>Edit <code>{file.path}</code></label></b>
        <span>Save it as a pull request to review first{access.data?.allowed ? `, or push it straight to ${access.data.branch}` : ""}.</span>
      </header>
      <textarea id={textId} className="policy-text" value={text} spellCheck={false} disabled={busy} aria-invalid={problem ? true : undefined} onChange={(event) => edited(event.target.value)} />
      {problem ? <div className="sentences">{problem.split("\n").map((line) => <p key={line} className="reason">{line}</p>)}</div> : null}
      {held ? (
        <div className="confirm" role="alert">
          <div className="sentences"><MergeCaution source={source} risks={held.risks} /></div>
          <div className="acts">
            <Button type="button" size="sm" disabled={busy} onClick={() => write(held.save)}>{saveWords(held.save)} anyway</Button>
            <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setHeld(null)}>Keep editing</Button>
          </div>
        </div>
      ) : (
        <div className="acts">
          <Button type="button" size="sm" disabled={busy || text === file.text} onClick={() => void check("pull")}>{saveWords("pull")}</Button>
          {access.data?.allowed ? <Button type="button" variant="outline" size="sm" disabled={busy || text === file.text} onClick={() => void check("push")}>{saveWords("push")}</Button> : null}
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={onDone}>Cancel</Button>
        </div>
      )}
      {access.data && !access.data.allowed ? <p className="help">{access.data.reason}</p> : null}
      {error ? <p role="alert" className="error">{errorText(error)}</p> : null}
    </section>
  );
}
