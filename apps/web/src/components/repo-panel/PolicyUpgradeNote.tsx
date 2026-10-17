import { Button } from "@corbits/react-ui";
import { errorText } from "@corbits/common";
import { POLICY_FILE_PATH } from "@corbits/triage-contracts";
import { usePolicyUpgradeActions, type PolicyUpgradeRow } from "../../lib/policy-upgrades.ts";
import { ExternalIcon } from "../inbox-icons.tsx";

type PolicyUpgradeNoteProps = { row: PolicyUpgradeRow; disabled: boolean; onSettled: () => void };

/** Saved rules that still need moving into the repository's policy file, and the ways to move them. */
export default function PolicyUpgradeNote({ row, disabled, onSettled }: PolicyUpgradeNoteProps) {
  const { propose, keepFile } = usePolicyUpgradeActions(row.repo, onSettled);
  const upgrade = row.upgrade;
  if (row.error) return <p role="alert" className="error">{row.error}</p>;
  if (!upgrade || upgrade.state === "ok") return null;
  const busy = disabled || propose.isPending || keepFile.isPending;
  const pull = propose.data ?? row.pull;
  const error = propose.error ?? keepFile.error;

  /** With a pull request open, asking again brings it up to date with the saved rules. */
  function pullActions(label: string) {
    const ask = <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => propose.mutate()}>{pull ? "Update pull request" : label}</Button>;
    if (!pull) return ask;
    return <>{ask}<Button asChild variant="ghost" size="sm"><a href={pull.url} target="_blank" rel="noreferrer">Pull request #{pull.number} <ExternalIcon /></a></Button></>;
  }

  function notes(lines: readonly string[]) {
    return lines.length ? <ul>{lines.map((line, at) => <li key={`${at}-${line}`}>{line}</li>)}</ul> : null;
  }

  if (upgrade.state === "upgrade") {
    return (
      <div className="alert" role="status">
        <span className="mk flag">!</span>
        <div>
          <b>Upgrade this repository to a policy file</b>
          <p>Your saved rules move into <code>{POLICY_FILE_PATH}</code> through a pull request, and keep applying until it is merged.</p>
          {notes(upgrade.unexpressed)}
          <div className="acts">{pullActions("Open pull request")}</div>
          {error ? <p role="alert" className="error">{errorText(error)}</p> : null}
        </div>
      </div>
    );
  }
  return (
    <div className="alert" role="status">
      <span className="mk flag">!</span>
      <div>
        <b>Your policy file differs from your saved rules</b>
        <p>Your saved rules apply until they match.</p>
        {notes(upgrade.differences)}
        {notes(upgrade.unexpressed)}
        <div className="acts">
          {upgrade.fixable ? pullActions("Make the file match") : null}
          <Button type="button" variant="ghost" size="sm" disabled={busy} onClick={() => keepFile.mutate(upgrade.saved.id)}>Keep the file</Button>
        </div>
        {error ? <p role="alert" className="error">{errorText(error)}</p> : null}
      </div>
    </div>
  );
}
