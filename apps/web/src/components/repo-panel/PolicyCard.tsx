import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, type PolicyFileStatus, type RepoSource } from "@corbits/triage-contracts";
import { useRepoPack as useStoredPack } from "../../lib/check-packs.ts";
import type { usePolicyFile } from "../../lib/policy-file.ts";
import { ExternalIcon } from "../inbox-icons.tsx";

type PolicyCardProps = { repo: string; source: RepoSource; policyFile: ReturnType<typeof usePolicyFile>; disabled: boolean };

const HOST_NAME: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

const IN_HUB = <>Rules are kept in Corbits Triage. Add <code>{POLICY_FILE_PATH}</code> to the repository to keep them in the file.</>;

function sourceText(file: PolicyFileStatus | null) {
  if (!file) return IN_HUB;
  return <>From <code>{file.path}</code> on the default branch</>;
}

/** Where the repository's policy comes from: its policy file when it has one, else an offer to export it there where the host supports it. */
export default function PolicyCard({ repo, source, policyFile, disabled }: PolicyCardProps) {
  const { file: query, exported } = policyFile;
  const stored = useStoredPack(repo);
  const file = query.data;

  function fileRow(found: PolicyFileStatus) {
    return (
      <div className="sentence rule">
        <div className="rmain">
          <div className="rline"><span className="w">{found.problem ? "Triage runs nothing until the file is fixed:" : "The rules and steps below are read from the file."}</span></div>
          {found.problem?.split("\n").map((line) => <p key={line} className="reason">{line}</p>)}
        </div>
        <Button asChild variant="ghost" size="sm"><a href={found.url} target="_blank" rel="noreferrer">Edit on {HOST_NAME[source]} <ExternalIcon /></a></Button>
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
    return (
      <section className="gcard" aria-label="Policy">
        <header>
          <b>Policy</b>
          <span role="status">Could not read <code>{POLICY_FILE_PATH}</code>: {errorText(query.error)} Rules stay read-only until it can be read. <button type="button" className="linkish quiet" onClick={() => void query.refetch()}>Try again</button></span>
        </header>
      </section>
    );
  }
  if (file === undefined || (file === null && !stored)) return null;
  // The hub opens the export pull request on GitHub only.
  const exportable = source === "github";
  return (
    <section className="gcard" aria-label="Policy">
      <header>
        <b>Policy</b>
        <span>{sourceText(file)}</span>
      </header>
      {file ? <div className="sentences">{fileRow(file)}</div> : null}
      {!file && exportable ? <div className="sentences">{exportRow()}</div> : null}
      {exported.error ? <p role="alert" className="error">{errorText(exported.error)}</p> : null}
    </section>
  );
}
