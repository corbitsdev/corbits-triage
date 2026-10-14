import { useEffect, useRef, type RefObject } from "react";
import { Link, useParams } from "react-router-dom";
import { isPerson, type HubPrincipal, type PortalSnapshot } from "../lib/hub-api.ts";
import { counted } from "../lib/plural.ts";
import { usePortal } from "../lib/portal.tsx";
import { useDeployedWorkflows, usePrincipals, type TenantSection } from "../lib/tenant-entities.ts";
import { AccessSection } from "../components/settings/AccessSection.tsx";
import { AccountSection } from "../components/settings/AccountSection.tsx";
import { GithubSection } from "../components/settings/GithubSection.tsx";
import { ModelSection } from "../components/settings/ModelSection.tsx";
import { TriageSection } from "../components/settings/TriageSection.tsx";

const SECTIONS = [
  { id: "triage", label: "Triage" },
  { id: "github", label: "GitHub" },
  { id: "model", label: "Decision model" },
  { id: "access", label: "Access" },
  { id: "account", label: "Your account" },
] as const;

/** The workspace's name, then its people once they are known, then its repositories. */
function byline(snapshot: PortalSnapshot, people: TenantSection<HubPrincipal>): string {
  const parts = [snapshot.tenantName];
  if (!people.loading && !people.denied && !people.unavailable) parts.push(counted(people.rows.filter(isPerson).length, "person", "people"));
  parts.push(counted(snapshot.repos.length, "repository", "repositories"));
  return parts.join(" · ");
}

const READER_SCROLLS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Keeps the linked section at the top while the sections above it load and grow, until the reader takes over. */
function useLinkedSection(id: string | undefined, page: RefObject<HTMLElement | null>, ready: boolean) {
  useEffect(function followLinkedSection() {
    const main = page.current;
    if (!id || !ready || !main) return;
    const target = id;
    function align() {
      document.getElementById(target)?.scrollIntoView();
    }
    const observer = new ResizeObserver(align);
    function release() {
      observer.disconnect();
      for (const event of READER_SCROLLS) window.removeEventListener(event, release);
    }
    for (const section of main.children) observer.observe(section);
    for (const event of READER_SCROLLS) window.addEventListener(event, release, { passive: true });
    return release;
  }, [id, page, ready]);
}

export default function Settings() {
  const { snapshot } = usePortal();
  const { tab } = useParams();
  const people = usePrincipals();
  const deployed = useDeployedWorkflows();
  const page = useRef<HTMLElement>(null);
  useLinkedSection(tab, page, snapshot !== null);

  if (!snapshot) return null;
  return (
    <main className="settings" id="main" ref={page}>
      <h1>Workspace settings</h1>
      <p className="lede">{byline(snapshot, people)}</p>
      <nav className="byline" aria-label="Settings sections">
        {SECTIONS.map((section) => <Link key={section.id} className="linkish quiet" to={`/settings/${section.id}`}>{section.label}</Link>)}
      </nav>
      <TriageSection repos={snapshot.repos} deployed={deployed} />
      <GithubSection snapshot={snapshot} />
      <ModelSection snapshot={snapshot} />
      <AccessSection repos={snapshot.repos} />
      <AccountSection />
    </main>
  );
}
