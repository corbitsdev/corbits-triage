import { citationOf, citationUrl, type CheckOutput } from "@corbits/triage-contracts";

/** An evidence line, linked to the lines it cites at `sha` when the check's output carries them. */
export function CitedEvidence({ text, output, repo, sha }: { text: string; output: CheckOutput | null; repo: string; sha: string | null }) {
  const citation = citationOf(output, text);
  const url = citation && sha ? citationUrl(repo, sha, citation) : undefined;
  return url ? <a href={url} target="_blank" rel="noreferrer">{text}</a> : <>{text}</>;
}
