import { citationOf, type CheckOutput, type RepoSource } from "@corbits/triage-contracts";
import { useBitbucketDatacenterConnection } from "../lib/bitbucket-datacenter.ts";
import { evidenceUrl } from "../lib/evidence-url.ts";

export function CitedEvidence({ text, output, source, repo, sha }: { text: string; output: CheckOutput | null; source: RepoSource; repo: string; sha: string | null }) {
  const baseUrl = useBitbucketDatacenterConnection().data?.baseUrl;
  const citation = citationOf(output, text);
  const url = citation && sha ? evidenceUrl({ source, baseUrl, repo, sha, citation }) : undefined;
  return url ? <a href={url} target="_blank" rel="noreferrer">{text}</a> : <>{text}</>;
}
