import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { useRepoPack as useStoredPack } from "../../lib/check-packs.ts";
import { relativeTime } from "../../lib/duration.ts";
import type { usePolicyFile } from "../../lib/policy-file.ts";
import { ExternalIcon } from "../inbox-icons.tsx";

type PolicyCardProps = { repo: string; policyFile: ReturnType<typeof usePolicyFile>; disabled: boolean };

/** Where the repository's policy comes from: its `.corbits-triage.yaml` when it has one, else an offer to export it there. */
export default function PolicyCard({ repo, policyFile, disabled }: PolicyCardProps) {
  const { file: query, sync, exported } = policyFile;
  const stored = useStoredPack(repo);
  const file = query.data;
  const failed = sync.error ?? exported.error;

  function fileRow() {
    if (!file) return null;
    return (
      <div className="sentence rule">
        <div className="rmain">
          <div className="rline"><span className="w">{file.inSync ? "The rules and steps below are read from the file." : "Not in sync: the policy differs from the file."}</span></div>
          {file.problem ? <p className="reason">The file is not used: {file.problem}</p> : null}
        </div>
        {file.inSync || file.problem ? null : <Button type="button" variant="outline" size="sm" disabled={disabled || sync.isPending} onClick={() => sync.mutate()}>Use file</Button>}
        <Button asChild variant="ghost" size="sm"><a href={file.url} target="_blank" rel="noreferrer">Edit on GitHub <ExternalIcon /></a></Button>
      </div>
    );
  }

  function exportRow() {
    if (exported.data) {
      return <div className="sentence"><span className="w">Pull request opened.</span><Button asChild variant="ghost" size="sm"><a href={exported.data.url} target="_blank" rel="noreferrer">#{exported.data.number} <ExternalIcon /></a></Button></div>;
    }
    return (
      <div className="sentence">
        <div className="rmain"><span className="w">Keep this policy in the repository, so changes to it are reviewed like code.</span></div>
        <Button type="button" variant="outline" size="sm" disabled={disabled || exported.isPending} onClick={() => exported.mutate()}>Export to repository</Button>
      </div>
    );
  }

  if (query.data === undefined || (file === null && !stored)) return null;
  return (
    <section className="gcard" aria-label="Policy">
      <header>
        <b>Policy</b>
        <span>{file ? <>From <code>{POLICY_FILE_PATH}</code> on the default branch{file.syncedAt ? ` · synced ${relativeTime(file.syncedAt)}` : ""}</> : "Kept in Corbits Triage."}</span>
      </header>
      <div className="sentences">{file ? fileRow() : exportRow()}</div>
      {failed ? <p role="alert" className="error">{errorText(failed)}</p> : null}
    </section>
  );
}
