import { prFromUrl, prKey } from "../pr.ts";
import { tourPending } from "../storage.ts";

const EXAMPLE_REPO = "corbitsdev/corbits-triage";
/** Shown when the repository has no open pull request, or GitHub cannot list them right now. */
const KNOWN_EXAMPLE = 158;

export async function openPr(url: string): Promise<void> {
  await browser.tabs.create({ url });
}

/** The repository's newest open pull request, so the tour shows live checks rather than a merged one's. */
async function exampleUrl(): Promise<string> {
  try {
    const res = await fetch(`https://api.github.com/repos/${EXAMPLE_REPO}/pulls?state=open&per_page=1`, { headers: { accept: "application/vnd.github+json" } });
    const [newest] = res.ok ? ((await res.json()) as Array<{ number?: number }>) : [];
    if (newest?.number) return `https://github.com/${EXAMPLE_REPO}/pull/${newest.number}`;
  } catch (cause) {
    console.warn(`Could not list ${EXAMPLE_REPO}'s open pull requests: ${String(cause)}`);
  }
  return `https://github.com/${EXAMPLE_REPO}/pull/${KNOWN_EXAMPLE}`;
}

export async function openExamplePr(): Promise<void> {
  const url = await exampleUrl();
  await tourPending.setValue(prKey(prFromUrl(url)!));
  await openPr(url);
}
