import { citationOf, citationUrl, type CheckOutput } from "@corbits/triage-contracts";

export function CitedEvidence({ text, output, repo, sha }: { text: string; output: CheckOutput | null; repo: string; sha: string | null }) {
  const citation = citationOf(output, text);
  const url = citation && sha ? citationUrl(repo, sha, citation) : undefined;
  return url ? <a href={url} target="_blank" rel="noreferrer">{text}</a> : <>{text}</>;
}
