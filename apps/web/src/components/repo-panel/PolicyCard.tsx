import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, type PolicyFileStatus, type RepoSource } from "@corbits/triage-contracts";
import type { usePolicyFile } from "../../lib/policy-file.ts";
import { ExternalIcon } from "../inbox-icons.tsx";

/** `savedApply`: the file differs from the saved rules, which apply until they match. */
type PolicyCardProps = { source: RepoSource; policyFile: ReturnType<typeof usePolicyFile>; savedApply: boolean };

const HOST_NAME: Record<RepoSource, string> = { github: "GitHub", "bitbucket-datacenter": "Bitbucket" };

/** The repository's policy file, when it has one; moving saved rules into it is PolicyUpgradeNote's. */
export default function PolicyCard({ source, policyFile, savedApply }: PolicyCardProps) {
  const file = policyFile.data;

  function fileSentence(found: PolicyFileStatus): string {
    if (savedApply) return "Your saved rules below apply until the file matches them.";
    return found.problem ? "Triage runs nothing until the file is fixed:" : "The rules and steps below are read from the file.";
  }

  function fileRow(found: PolicyFileStatus) {
    return (
      <div className="sentence rule">
        <div className="rmain">
          <div className="rline"><span className="w">{fileSentence(found)}</span></div>
          {found.problem?.split("\n").map((line) => <p key={line} className="reason">{line}</p>)}
        </div>
        <Button asChild variant="ghost" size="sm"><a href={found.url} target="_blank" rel="noreferrer">Edit on {HOST_NAME[source]} <ExternalIcon /></a></Button>
      </div>
    );
  }

  if (policyFile.isError) {
    return (
      <section className="gcard" aria-label="Policy">
        <header>
          <b>Policy</b>
          <span role="status">Could not read <code>{POLICY_FILE_PATH}</code>: {errorText(policyFile.error)} Rules stay read-only until it can be read. <button type="button" className="linkish quiet" onClick={() => void policyFile.refetch()}>Try again</button></span>
        </header>
      </section>
    );
  }
  if (!file) return null;
  return (
    <section className="gcard" aria-label="Policy">
      <header>
        <b>Policy</b>
        <span>From <code>{file.path}</code> on the default branch</span>
      </header>
      <div className="sentences">{fileRow(file)}</div>
    </section>
  );
}
