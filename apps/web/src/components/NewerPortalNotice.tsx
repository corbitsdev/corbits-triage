import { Button } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";

const DEPLOYED_BUILD_QUERY_KEY = ["portal", "deployed-build"] as const;
const CHECK_INTERVAL_MS = 60_000;

/** A portal build is named by its hashed entry script, which every deploy that changes the portal renames. */
function buildOf(page: Document): string | null {
  return page.querySelector('script[type="module"][src]')?.getAttribute("src") ?? null;
}

async function deployedBuild(): Promise<string | null> {
  const response = await fetch("/", { cache: "no-store" });
  if (!response.ok) throw new Error(`The portal page answered ${response.status}.`);
  return buildOf(new DOMParser().parseFromString(await response.text(), "text/html"));
}

function reload() {
  window.location.reload();
}

/** Offers a reload once the portal is deployed again while this tab runs the build it opened with. */
export default function NewerPortalNotice() {
  const deployed = useQuery({ queryKey: DEPLOYED_BUILD_QUERY_KEY, queryFn: deployedBuild, refetchInterval: CHECK_INTERVAL_MS });
  const newer = typeof deployed.data === "string" && deployed.data !== buildOf(document);
  // The status region stays mounted so screen readers announce the notice when it appears.
  return (
    <div role="status">
      {newer ? (
        <div className="newer-portal">
          <span>A new version of Corbits Triage is available.</span>
          <Button size="sm" onClick={reload}>Reload</Button>
        </div>
      ) : null}
    </div>
  );
}
