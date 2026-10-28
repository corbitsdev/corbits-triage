import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, type ActionKind, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import type { CheckPackArtifact } from "../../lib/hub-api.ts";
import { checkPackQuery } from "../../lib/check-packs.ts";
import { usePolicyFile } from "../../lib/policy-file.ts";
import { usePortal } from "../../lib/portal.tsx";
import { usePolicyUpgrade, useSettled } from "../../lib/policy-upgrades.ts";
import { CheckIcon, ExternalIcon } from "../inbox-icons.tsx";
import PolicyEditor from "./PolicyEditor.tsx";
import PolicyRules from "./PolicyRules.tsx";
import PolicyStart, { HOST_NAME } from "./PolicyStart.tsx";

/** What Triage may do on its own; nothing when the policy could not be read. */
function automaticOf(read: CheckPackArtifact | null | undefined): readonly ActionKind[] {
  return read?.kind === "file" ? read.automatic : [];
}

type PolicySectionProps = { repo: string; source: RepoSource; pack: CheckPack | null; disabled: boolean };

/** The repository's policy file read back as sentences and edited in place, or the steps that start one. */
export default function PolicySection({ repo, source, pack, disabled }: PolicySectionProps) {
  const { snapshot } = usePortal();
  const policyFile = usePolicyFile(repo, source);
  const policy = useQuery(checkPackQuery(snapshot?.workspace.tenantId, repo, source));
  const row = usePolicyUpgrade(repo);
  const settled = useSettled(repo);
  const [editing, setEditing] = useState(false);
  const file = policyFile.data;
  const host = HOST_NAME[source];

  function rules() {
    if (file?.problem) {
      return (
        <div className="gcard">
          <div className="sentences">
            <div className="sentence"><span className="txt">Triage runs nothing until the file is fixed:</span></div>
            {file.problem.split("\n").map((line) => <p key={line} className="reason">{line}</p>)}
          </div>
        </div>
      );
    }
    return pack ? <PolicyRules pack={pack} source={source} automatic={automaticOf(policy.data)} /> : null;
  }

  function body() {
    if (row?.error) return <p role="alert" className="error">{row.error}</p>;
    if (policyFile.isError) {
      return <p role="alert" className="error">Could not read <code>{POLICY_FILE_PATH}</code>: {errorText(policyFile.error)} <Button type="button" variant="link" size="sm" onClick={() => void policyFile.refetch()}>Try again</Button></p>;
    }
    if (file === undefined || policy.isLoading) return null;
    if (file === null) return <PolicyStart repo={repo} source={source} pull={row?.pull} disabled={disabled} />;
    const { text } = file;
    if (editing && text !== undefined) return <PolicyEditor repo={repo} source={source} file={{ ...file, text }} onDone={() => setEditing(false)} />;
    return (
      <>
        {settled ? <p className="moved"><span className="mk ok"><CheckIcon /></span><span>Done. Your rules now come from <code>{file.path}</code>.</span></p> : null}
        {rules()}
      </>
    );
  }

  const canEdit = file?.text !== undefined && !editing && !disabled;

  return (
    <section className="rs policy" aria-labelledby="rs-policy" id="rp-policy">
      <div className="rs-h">
        <h3 id="rs-policy">Policy</h3>
        {canEdit ? <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(true)}>Edit</Button> : null}
        {file ? <Button asChild variant="ghost" size="sm"><a href={file.url} target="_blank" rel="noreferrer">Open on {host} <ExternalIcon /></a></Button> : null}
      </div>
      {body()}
    </section>
  );
}
