import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, type PolicyFileStatus } from "@corbits/triage-contracts";
import { useRepoPack as useStoredPack } from "../../lib/check-packs.ts";
import { relativeTime } from "../../lib/duration.ts";
import type { usePolicyFile } from "../../lib/policy-file.ts";
import { ExternalIcon } from "../inbox-icons.tsx";

type PolicyCardProps = { repo: string; policyFile: ReturnType<typeof usePolicyFile>; disabled: boolean };

function sourceText(file: PolicyFileStatus | null) {
  if (!file) return "Kept in Corbits Triage.";
  return <>From <code>{POLICY_FILE_PATH}</code> on the default branch{file.syncedAt ? ` · synced ${relativeTime(file.syncedAt)}` : ""}</>;
}

/** Where the repository's policy comes from: its `.corbits-triage.yaml` when it has one, else an offer to export it there. */
export default function PolicyCard({ repo, policyFile, disabled }: PolicyCardProps) {
  const { file: query, sync, exported } = policyFile;
  const stored = useStoredPack(repo);
  const file = query.data;
  const failed = sync.error ?? exported.error;

  function fileRow(found: PolicyFileStatus) {
    return (
      <div className="sentence rule">
        <div className="rmain">
          <div className="rline"><span className="w">{found.inSync ? "The rules and steps below are read from the file." : "Not in sync: the policy differs from the file."}</span></div>
          {found.problem ? <p className="reason">The file is not used: {found.problem}</p> : null}
        </div>
        {found.inSync || found.problem ? null : <Button type="button" variant="outline" size="sm" disabled={disabled || sync.isPending} onClick={() => sync.mutate()}>Use file</Button>}
        <Button asChild variant="ghost" size="sm"><a href={found.url} target="_blank" rel="noreferrer">Edit on GitHub <ExternalIcon /></a></Button>
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

  if (query.isError) {
    return <p role="alert" className="error">Could not read {POLICY_FILE_PATH}, so the rules and steps stay read-only: {errorText(query.error)} <button type="button" className="linkish" onClick={() => void query.refetch()}>Try again</button></p>;
  }
  if (file === undefined || (file === null && !stored)) return null;
  return (
    <section className="gcard" aria-label="Policy">
      <header>
        <b>Policy</b>
        <span>{sourceText(file)}</span>
      </header>
      <div className="sentences">{file ? fileRow(file) : exportRow()}</div>
      {failed ? <p role="alert" className="error">{errorText(failed)}</p> : null}
    </section>
  );
}
