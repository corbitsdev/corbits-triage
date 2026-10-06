// SPDX-License-Identifier: GPL-2.0-only
import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router-dom";
import { PortalProvider, usePortal } from "./lib/portal.tsx";
import { SessionProvider, useSession } from "./lib/session.tsx";
import { DeniedNotice } from "./lib/denied.tsx";
import type { PortalSnapshot } from "./lib/hub-api.ts";
import Layout from "./components/Layout.tsx";
import Connect from "./pages/Connect.tsx";
import { hasDecisionModelCredential } from "./lib/decision-models.ts";
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

export default function App() {
  const [queryClient] = useState(createPortalQueryClient);
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <AppShell />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
