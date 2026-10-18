import { type } from "arktype";

export const Checkout = type({ source: "'github' | 'bitbucket-datacenter'", repo: "string", sha: /^[0-9a-f]{40}$/ });
export type Checkout = typeof Checkout.infer;

export const CHECKOUT_TOOL = { github: "github_checkout", "bitbucket-datacenter": "bitbucket_datacenter_checkout" } as const;

export const READ_FILE_TOOL = { github: "github_read_file", "bitbucket-datacenter": "bitbucket_datacenter_read_file" } as const;

// A director that checks the repository out reads the checkout from the first line of its input message.
const REPOSITORY_TAG = /^<repository host="(github|bitbucket-datacenter)" name="([^"]+)" head="([0-9a-f]{40})"\/>\n/;

export function repositoryTag({ source, repo, sha }: Checkout): string {
  return `<repository host="${source}" name="${repo}" head="${sha}"/>\n`;
}

/** The checkout an input message names, if any. */
export function checkoutOf(text: string): Checkout | undefined {
  const match = REPOSITORY_TAG.exec(text);
  if (!match) return undefined;
  const [, source, repo, sha] = match;
  return { source: source as Checkout["source"], repo: repo!, sha: sha! };
}

export const DEFAULT_BUDGET = 400_000;

// A director that reads the repository on a budget of billable tokens reads it from the line after the checkout.
const BUDGET_TAG = /^<budget tokens="(\d+)"\/>\n/m;

export function budgetTag(tokens: number): string {
  return `<budget tokens="${tokens}"/>\n`;
}

/** The token budget an input message names, if any. */
export function budgetOf(text: string): number | undefined {
  const match = BUDGET_TAG.exec(text);
  return match ? Number(match[1]) : undefined;
}

// A reader whose budget ran out marks its reply with this line, so the review can say it stopped early.
export const BUDGET_EXHAUSTED = "<budget_exhausted/>\n";
