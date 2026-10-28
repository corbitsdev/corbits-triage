import { useEffect, useRef, useState, type RefObject } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import { connectedSources, isPerson, type HubPrincipal, type PortalSnapshot } from "../lib/hub-api.ts";
import { counted } from "../lib/plural.ts";
import { usePortal } from "../lib/portal.tsx";
import { useDeployedVersions, usePrincipals, type TenantSection } from "../lib/tenant-entities.ts";
import { InvitePeople } from "../components/InvitePeople.tsx";
import { AccountSection } from "../components/settings/AccountSection.tsx";
import { SupportVersions } from "../components/settings/SupportVersions.tsx";
import { TriageSection } from "../components/settings/TriageSection.tsx";

const SECTIONS = [
  { id: "triage", label: "Triage" },
  { id: "people", label: "People" },
  { id: "account", label: "Your account" },
] as const;

/** The workspace's name when it has one, then its people once they are known, then its repositories. */
function byline(snapshot: PortalSnapshot, people: TenantSection<HubPrincipal>): string {
  const parts: string[] = [];
  if (snapshot.tenantName) parts.push(snapshot.tenantName);
  if (!people.loading && !people.denied && !people.unavailable) parts.push(counted(people.rows.filter(isPerson).length, "person", "people"));
  parts.push(counted(snapshot.repos.length, "repository", "repositories"));
  return parts.join(" · ");
}

const READER_SCROLLS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** Puts the section at the top of whichever scrolls the page: the settings column, or the document on a phone. */
function scrollToSection(main: HTMLElement, id: string) {
  const section = document.getElementById(id);
  if (!section) return;
  if (main.scrollHeight > main.clientHeight) {
    main.scrollBy({ top: section.getBoundingClientRect().top - main.getBoundingClientRect().top });
    return;
  }
  window.scrollBy({ top: section.getBoundingClientRect().top });
}

/** On first load, keeps the linked section at the top while the sections above it load and grow, until the reader takes over. */
function useLinkedSection(id: string | undefined, page: RefObject<HTMLElement | null>, ready: boolean) {
  const [initial] = useState(id);
  useEffect(function followLinkedSection() {
    const main = page.current;
    if (!initial || !ready || !main) return;
    const target = initial;
    const scroller = main;
    function align() {
      scrollToSection(scroller, target);
    }
    const observer = new ResizeObserver(align);
    function release() {
      observer.disconnect();
      for (const event of READER_SCROLLS) window.removeEventListener(event, release);
    }
    for (const section of main.children) observer.observe(section);
    for (const event of READER_SCROLLS) window.addEventListener(event, release, { passive: true });
    return release;
  }, [initial, page, ready]);
}

export default function Settings() {
  const { snapshot } = usePortal();
  const { tab } = useParams();
  const people = usePrincipals();
  const deployed = useDeployedVersions();
  const page = useRef<HTMLElement>(null);
  useLinkedSection(tab, page, snapshot !== null);

  function jumpTo(id: string) {
    if (page.current) scrollToSection(page.current, id);
  }

  if (!snapshot) return null;
  if (tab === "code-review") return <Navigate to="/code-review#code-review" replace />;
  return (
    <main className="settings" id="main" ref={page}>
      <h1>Workspace settings</h1>
      <p className="lede">{byline(snapshot, people)}</p>
      <nav className="byline" aria-label="Settings sections">
        {SECTIONS.map((section) => <span key={section.id}><Link className="linkish quiet" to={`/settings/${section.id}`} replace onClick={() => jumpTo(section.id)}>{section.label}</Link></span>)}
      </nav>
      <TriageSection snapshot={snapshot} deployed={deployed} />
      <InvitePeople onSetupPage={false} />
      <AccountSection />
      {!deployed.denied && !deployed.loading && !deployed.unavailable && <SupportVersions deployments={deployed.rows} sources={connectedSources(snapshot.credentials)} />}
    </main>
  );
}
