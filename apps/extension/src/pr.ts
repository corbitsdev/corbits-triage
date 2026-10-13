export type PrRef = { repo: string; number: number };

const PR_PATH = /^\/([\w.-]+)\/([\w.-]+)\/pull\/(\d+)(?:\/|$)/;

/** The pull request a github.com URL shows, on any of its tabs. */
export function prFromUrl(url: string | undefined): PrRef | undefined {
  if (!url) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.hostname !== "github.com") return undefined;
  const match = PR_PATH.exec(parsed.pathname);
  if (!match) return undefined;
  return { repo: `${match[1]}/${match[2]}`, number: Number(match[3]) };
}

export function prKey(pr: PrRef): string {
  return `${pr.repo}#${pr.number}`;
}
