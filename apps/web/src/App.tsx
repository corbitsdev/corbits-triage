import { useEffect, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import { del, get, set } from "idb-keyval";
import { Toaster } from "sonner";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { PortalProvider, usePortal } from "./lib/portal.tsx";
import { SessionProvider, useSession } from "./lib/session.tsx";
import { DeniedNotice } from "./lib/denied.tsx";
import type { PortalSnapshot } from "./lib/hub-api.ts";
import Layout from "./components/Layout.tsx";
import LoadingIndicator from "./components/LoadingIndicator.tsx";
import Connect from "./pages/Connect.tsx";
import { hasDecisionModelCredential } from "./lib/decision-models.ts";
import { useGithubSync } from "./lib/github-sync.ts";
import { isFinishedRunLogQuery } from "./lib/run-logs.ts";
import { Welcome } from "./pages/Welcome.tsx";
import Triage from "./pages/Triage.tsx";
import PRDetail from "./pages/PRDetail.tsx";
import Repositories from "./pages/Repositories.tsx";
import RepoDetail from "./pages/RepoDetail.tsx";
import Settings from "./pages/Settings.tsx";

function TriageRedirect() {
  return <Navigate to="/triage/action" replace />;
}

function NotConfigured() {
  return (
    <div className="gate">
      <section className="onboarding centered-setup">
        <h1>Service URL not configured</h1>
        <p className="muted">Set VITE_HUB_URL to the Interchange hub URL, then reload this page.</p>
      </section>
    </div>
  );
}

function HubOutage({ message }: { message: string }) {
  return (
    <div className="gate">
      <section className="onboarding centered-setup">
        <h1>Service unavailable</h1>
        <p role="alert" className="error">
          {message}
        </p>
        <p className="muted">Check the service, then reload this page.</p>
      </section>
    </div>
  );
}

/** GitHub's Setup URL return for a workspace that is already set up (often inside the install popup). */
function GithubReturn() {
  const sync = useGithubSync(true);

  useEffect(function leaveAfterSync() {
    if (!sync.isSuccess) return;
    if (window.opener) window.close();
  }, [sync.isSuccess]);

  if (sync.error) return <HubOutage message={`Could not read your repositories from GitHub. ${sync.error.message}`} />;
  if (sync.isSuccess && !window.opener) return <Navigate to="/repositories" replace />;
  return <LoadingGate />;
}

function LoadingGate() {
  return (
    <main className="loading-gate" aria-busy="true" aria-label="Loading Corbits Triage">
      <img src="/corbits-mark.svg" width="40" height="40" alt="" />
      <div>
        <strong role="status">Loading…</strong>
      </div>
    </main>
  );
}

function DeniedGate({ snapshot }: { snapshot: PortalSnapshot }) {
  const sections: string[] = [];
  if (snapshot.denied.repos) sections.push("repositories");
  if (snapshot.denied.credentials) sections.push("credentials");
  return (
    <div className="gate">
      <section className="onboarding centered-setup" aria-label="Access denied">
        <h1>Access denied</h1>
        <p className="muted">
          You do not have access to {sections.join(" and ")}. Ask an administrator for access.
        </p>
        {sections.map((section) => (
          <DeniedNotice key={section} section={section} />
        ))}
      </section>
    </div>
  );
}

function Gate() {
  const { configured, loading, connected, loadError, snapshot } = usePortal();
  const { ready, session } = useSession();
  const location = useLocation();
  const path = location.pathname;

  if (!configured) return <NotConfigured />;
  if (!ready) return <LoadingGate />;
  if (!session) return <Welcome />;
  if (!snapshot) {
    if (loading || !loadError) return <LoadingGate />;
    return <HubOutage message={loadError || "Could not reach the service."} />;
  }
  if (snapshot.denied.repos || snapshot.denied.credentials) {
    return <DeniedGate snapshot={snapshot} />;
  }
  if (!connected || !hasDecisionModelCredential(snapshot.credentials) || path === "/connect") return <Connect />;

  if (path === "/" && new URLSearchParams(location.search).has("installation_id")) return <GithubReturn />;
  if (path === "/login" || path === "/") {
    return <Navigate to={snapshot.repos.length > 0 ? "/triage/action" : "/repositories"} replace />;
  }

  return (
    <Layout>
      <Routes>
        <Route path="/triage" element={<TriageRedirect />} />
        <Route path="/triage/action" element={<Triage />} />
        <Route path="/triage/merge" element={<Triage />} />
        <Route path="/triage/all" element={<Triage />} />
        <Route path="/triage/pr/:owner/:repo/:number" element={<PRDetail />} />
        <Route path="/triage/pr/:id" element={<PRDetail />} />
        <Route path="/queue" element={<TriageRedirect />} />
        <Route path="/queue/*" element={<TriageRedirect />} />
        <Route path="/approvals" element={<TriageRedirect />} />
        <Route path="/audit" element={<TriageRedirect />} />
        <Route path="/runs" element={<TriageRedirect />} />
        <Route path="/runs/*" element={<TriageRedirect />} />
        <Route path="/prs/:owner/:repo/:number" element={<PRDetail />} />
        <Route path="/prs/:id" element={<PRDetail />} />
        <Route path="/repositories" element={<Repositories />} />
        <Route path="/repositories/:id" element={<RepoDetail />} />
        <Route path="/repositories/:id/:tab" element={<RepoDetail />} />
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/:tab" element={<Settings />} />
        <Route path="/" element={<TriageRedirect />} />
        <Route path="*" element={<div className="empty">Page not found. Choose a page from the navigation.</div>} />
      </Routes>
    </Layout>
  );
}

export function AppShell() {
  return (
    <SessionProvider>
      <PortalProvider>
        <Gate />
        <LoadingIndicator />
        <Toaster position="bottom-right" />
      </PortalProvider>
    </SessionProvider>
  );
}

function createPortalQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        refetchOnWindowFocus: true,
        retry: false,
      },
    },
  });
}

const PERSISTED_QUERIES_KEY = "corbits.queries";
const PERSISTED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

async function getPersisted(key: string): Promise<string | null> {
  return (await get<string>(key)) ?? null;
}

/** Finished run logs never change, so they are kept in IndexedDB across reloads. */
const persister = createAsyncStoragePersister({
  storage: { getItem: getPersisted, setItem: set, removeItem: del },
  key: PERSISTED_QUERIES_KEY,
});

const persistOptions = {
  persister,
  maxAge: PERSISTED_MAX_AGE_MS,
  dehydrateOptions: { shouldDehydrateQuery: isFinishedRunLogQuery },
};

export default function App() {
  const [queryClient] = useState(createPortalQueryClient);
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={persistOptions}>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </PersistQueryClientProvider>
  );
}
