import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH, type CheckPack, type RepoSource } from "@corbits/triage-contracts";
import { usePolicyFile } from "../../lib/policy-file.ts";
import { usePolicyUpgrade, useSettled } from "../../lib/policy-upgrades.ts";
import { CheckIcon, ExternalIcon } from "../inbox-icons.tsx";
import PolicyMove, { HOST_NAME } from "./PolicyMove.tsx";
import PolicyRules from "./PolicyRules.tsx";

type PolicySectionProps = { repo: string; source: RepoSource; pack: CheckPack; disabled: boolean; onSettled: () => void };

/** The repository's policy file read back as sentences, or the steps that move its saved rules into one. */
export default function PolicySection({ repo, source, pack, disabled, onSettled }: PolicySectionProps) {
  const policyFile = usePolicyFile(repo);
  const row = usePolicyUpgrade(repo);
  const settled = useSettled(repo);
  const file = policyFile.data;
  const host = HOST_NAME[source];

  function body() {
    if (row?.error) return <p role="alert" className="error">{row.error}</p>;
    if (row?.upgrade && row.upgrade.state !== "ok") return <PolicyMove row={row} upgrade={row.upgrade} source={source} disabled={disabled} onSettled={onSettled} />;
    if (policyFile.isError) {
      return <p role="alert" className="error">Could not read <code>{POLICY_FILE_PATH}</code>: {errorText(policyFile.error)} <button type="button" className="linkish quiet" onClick={() => void policyFile.refetch()}>Try again</button></p>;
    }
    if (file === undefined) return null;
    if (file === null) return <p className="help">No policy file yet. Add <code>{POLICY_FILE_PATH}</code> to the default branch to set this repository's rules and actions.</p>;
    if (file.problem) {
      return (
        <div className="gcard">
          <div className="sentences">
            <div className="sentence"><span className="txt">Triage runs nothing until the file is fixed:</span></div>
            {file.problem.split("\n").map((line) => <p key={line} className="reason">{line}</p>)}
          </div>
        </div>
      );
    }
    return (
      <>
        {settled ? <p className="moved"><span className="mk ok"><CheckIcon /></span><span>Done. Your rules now come from <code>{file.path}</code>.</span></p> : null}
        <PolicyRules pack={pack} />
      </>
    );
  }

  return (
    <section className="rs policy" aria-labelledby="rs-policy" id="rp-policy">
      <div className="rs-h">
        <h3 id="rs-policy">Policy</h3>
        {file ? <Button asChild variant="ghost" size="sm"><a href={file.url} target="_blank" rel="noreferrer">Change on {host} <ExternalIcon /></a></Button> : null}
      </div>
      {body()}
    </section>
  );
}
