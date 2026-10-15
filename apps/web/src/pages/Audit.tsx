import { useMemo, useState } from "react";
import { Button, Input, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import type { AuditEntry } from "@corbits/triage-contracts";
import { errorText } from "@corbits/common";
import { AUDIT_LIMIT, matchingEntries, useAuditLog } from "../lib/audit-log.ts";
import { usePortal } from "../lib/portal.tsx";

function download(entries: readonly AuditEntry[], repo: string | null) {
  const blob = new Blob([JSON.stringify({ entries }, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `audit-${repo?.replace("/", "-") ?? "workspace"}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

function EntryRow({ entry }: { entry: AuditEntry }) {
  return (
    <TableRow>
      <TableCell className="mono"><time dateTime={entry.time} title={entry.time}>{new Date(entry.time).toLocaleString()}</time></TableCell>
      <TableCell>{entry.actor}</TableCell>
      <TableCell>{entry.action}</TableCell>
      <TableCell className="mono">{entry.target}</TableCell>
      <TableCell className="detail">{entry.detail}</TableCell>
    </TableRow>
  );
}

export default function Audit() {
  const { snapshot } = usePortal();
  const [repo, setRepo] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const log = useAuditLog(repo);
  const repos = useMemo(() => (snapshot?.repos ?? []).map((row) => row.name).sort(), [snapshot]);
  const entries = useMemo(() => matchingEntries(log.data?.entries ?? [], search), [log.data, search]);

  function renderLog() {
    if (log.error) return <p className="empty-line" role="alert">Could not load the audit log. {errorText(log.error)}</p>;
    if (log.data === undefined) return <p className="empty-line" role="status">Loading…</p>;
    if (entries.length === 0) return <p className="empty-line">{search.trim() === "" ? "Nothing recorded yet." : "Nothing matches this search."}</p>;
    return (
      <Table>
        <TableHeader>
          <TableRow><TableHead scope="col">Time</TableHead><TableHead scope="col">Actor</TableHead><TableHead scope="col">Action</TableHead><TableHead scope="col">Target</TableHead><TableHead scope="col">Detail</TableHead></TableRow>
        </TableHeader>
        <TableBody>{entries.map((entry, i) => <EntryRow key={`${entry.time}-${i}`} entry={entry} />)}</TableBody>
      </Table>
    );
  }

  return (
    <main className="audit" id="main">
      <h1>Audit</h1>
      <p className="lede">The latest {AUDIT_LIMIT} recorded events, newest first.</p>
      <div className="audit-bar">
        <Input type="search" aria-label="Search the audit log" placeholder="Search actor, action, pull request…" value={search} onChange={(event) => setSearch(event.target.value)} />
        <select aria-label="Repository" value={repo ?? ""} onChange={(event) => setRepo(event.target.value === "" ? null : event.target.value)}>
          <option value="">All repositories</option>
          {repos.map((name) => <option key={name} value={name}>{name}</option>)}
        </select>
        <Button type="button" variant="outline" disabled={entries.length === 0} onClick={() => download(entries, repo)}>Export</Button>
      </div>
      {renderLog()}
    </main>
  );
}
