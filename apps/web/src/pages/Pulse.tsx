import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatGrid, StatGridItem, Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";
import type { PrItem, RepoRecord } from "../lib/hub-api.ts";
import { titleText } from "../lib/inbox-pane.ts";
import { ageText, listHref } from "../lib/inbox-view.ts";
import { relativeTime } from "../lib/duration.ts";
import { usePortal } from "../lib/portal.tsx";
import type { ResolvedPull } from "../lib/pulse.ts";
import { usePulse, type Pulse as PulseData } from "../lib/pulse-visit.tsx";
import type { RepoPackStore } from "../lib/repo-pack-store.ts";
import { useHubRepoPackStore } from "../lib/repo-pack.ts";
import { triageEnabledRepos } from "../lib/repo-rows.ts";
import { OUTCOME_NAMES, WEEK_DAYS, actedOn, medianText, outcomesView, repoStatsQuery, type OutcomeField, type OutcomesView } from "../lib/repo-stats.ts";
import { ExternalIcon } from "../components/inbox-icons.tsx";

function OpenLine({ item, note }: { item: PrItem; note?: string }) {
  return (
    <li>
      <Link to={listHref("all-open", item)}>
        <span><b>{titleText(item.title)}</b><span className="mono">{item.repo} #{item.number}</span></span>
        {note ? <span className="note">{note}</span> : null}
      </Link>
    </li>
  );
}

function ResolvedLine({ pull }: { pull: ResolvedPull }) {
  const url = pull.url ?? `https://github.com/${pull.repo}/pull/${pull.number}`;
  return (
    <li>
      <a href={url} target="_blank" rel="noreferrer">
        <span><b>{titleText(pull.title)}</b><span className="mono">{pull.repo} #{pull.number}</span></span>
        <ExternalIcon />
      </a>
    </li>
  );
}

function PullList({ title, children, count }: { title: string; count: number; children: ReactNode }) {
  if (count === 0) return null;
  return (
    <>
      <h3>{title} <span className="n">{count}</span></h3>
      <ul className="plist">{children}</ul>
    </>
  );
}

function SinceVisit({ pulse }: { pulse: PulseData }) {
  const { fresh, resolved, turned } = pulse.since;
  if (pulse.firstVisit) {
    return (
      <section aria-labelledby="pulse-since">
        <h2 id="pulse-since">Since your last visit</h2>
        <p className="empty-line">Changes show here from your next visit.</p>
      </section>
    );
  }
  return (
    <section aria-labelledby="pulse-since">
      <h2 id="pulse-since">Since your last visit</h2>
      <p className="lede">Your last visit ended {relativeTime(pulse.visit.at)}.</p>
      <StatGrid columns={4}>
        <StatGridItem label="New" value={String(fresh.length)} />
        <StatGridItem label="Resolved" value={String(resolved.length)} />
        <StatGridItem label="Now waiting on you" value={String(turned.length)} />
        <StatGridItem label="Acted on by you" value={String(pulse.acted)} />
      </StatGrid>
      {fresh.length + resolved.length + turned.length === 0 ? <p className="empty-line">Nothing changed since your last visit.</p> : null}
      <PullList title="New" count={fresh.length}>{fresh.map((item) => <OpenLine key={item.key} item={item} />)}</PullList>
      <PullList title="Resolved" count={resolved.length}>{resolved.map((pull) => <ResolvedLine key={pull.key} pull={pull} />)}</PullList>
      <PullList title="Now waiting on you" count={turned.length}>{turned.map((item) => <OpenLine key={item.key} item={item} />)}</PullList>
    </section>
  );
}

function Stuck({ stuck }: { stuck: PrItem[] }) {
  return (
    <section aria-labelledby="pulse-stuck">
      <h2 id="pulse-stuck">Stuck <span className="n">{stuck.length}</span></h2>
      {stuck.length === 0 ? <p className="empty-line">Nothing has waited on you longer than 3 days.</p> : (
        <ul className="plist">{stuck.map((item) => <OpenLine key={item.key} item={item} note={ageText(item.waitingSince)} />)}</ul>
      )}
    </section>
  );
}

const PULSE_OUTCOMES: OutcomeField[] = ["mergeOrCloseMs", "firstHumanResponseMs"];

function OutcomeCell({ field, view }: { field: OutcomeField; view: Exclude<OutcomesView, { missing: string }> }) {
  const { baseline } = view;
  return (
    <TableCell className="outcome">
      <b>{medianText(view.triaged[field])}</b>
      {baseline && <span className="was">vs {medianText(baseline[field])} before</span>}
    </TableCell>
  );
}

function HumansCell({ view }: { view: OutcomesView | null }) {
  if (view === null || "missing" in view) return <TableCell />;
  return <TableCell>{view.humans}</TableCell>;
}

function OutcomeCells({ view }: { view: OutcomesView | null }) {
  if (view === null) return <TableCell colSpan={PULSE_OUTCOMES.length} />;
  if ("missing" in view) return <TableCell colSpan={PULSE_OUTCOMES.length} className="note">{view.missing}</TableCell>;
  return <>{PULSE_OUTCOMES.map((field) => <OutcomeCell key={field} field={field} view={view} />)}</>;
}

function OutcomeNote({ view }: { view: OutcomesView | null }) {
  if (view === null || "missing" in view) return null;
  return (
    <>
      <span className="was">median of {view.triaged.prs}</span>
      {view.baselineMissing && <span className="was">{view.baselineMissing}</span>}
    </>
  );
}

function RepoWeek({ store, repo }: { store: RepoPackStore | null; repo: RepoRecord }) {
  const { data: stats, isError } = useQuery(repoStatsQuery(store, repo.name, WEEK_DAYS));
  const view = stats ? outcomesView(stats.outcomes, repo.source) : null;
  const note = isError ? "Could not load this repository's numbers." : "Loading…";
  return (
    <TableRow>
      <TableHead scope="row">{repo.name}<OutcomeNote view={view} /></TableHead>
      {stats ? (
        <>
          <TableCell>{stats.triaged}</TableCell>
          <TableCell>{stats.neededYou}</TableCell>
          <HumansCell view={view} />
          <TableCell>{actedOn(stats)}</TableCell>
          <OutcomeCells view={view} />
        </>
      ) : <TableCell colSpan={4 + PULSE_OUTCOMES.length} className="note">{note}</TableCell>}
    </TableRow>
  );
}

function byName(a: RepoRecord, b: RepoRecord): number {
  return a.name.localeCompare(b.name);
}

function ThisWeek() {
  const { snapshot } = usePortal();
  const store = useHubRepoPackStore();
  const repos = useMemo(function enabledRepos() {
    const all = snapshot?.repos ?? [];
    const enabled = triageEnabledRepos(all);
    return all.filter((repo) => enabled.has(repo.name)).toSorted(byName);
  }, [snapshot]);
  return (
    <section aria-labelledby="pulse-week">
      <h2 id="pulse-week">This week, per repository</h2>
      {repos.length === 0 ? <p className="empty-line">No repository has triage on.</p> : (
        <Table>
          <TableHeader>
            <TableRow><TableHead scope="col">Repository</TableHead><TableHead scope="col">Triaged</TableHead><TableHead scope="col">Needed you</TableHead><TableHead scope="col">Humans involved</TableHead><TableHead scope="col">Acted on</TableHead>{PULSE_OUTCOMES.map((field) => <TableHead key={field} scope="col">{OUTCOME_NAMES[field]}</TableHead>)}</TableRow>
          </TableHeader>
          <TableBody>{repos.map((repo) => <RepoWeek key={repo.name} store={store} repo={repo} />)}</TableBody>
        </Table>
      )}
    </section>
  );
}

export default function Pulse() {
  const { pulse } = usePulse();
  return (
    <main className="pulse" id="main">
      <h1>Pulse</h1>
      {pulse ? (
        <>
          <SinceVisit pulse={pulse} />
          <Stuck stuck={pulse.stuck} />
        </>
      ) : <p className="empty-line" role="status">Loading…</p>}
      <ThisWeek />
    </main>
  );
}
