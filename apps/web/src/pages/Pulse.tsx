import { useMemo, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { StatGrid, StatGridItem } from "@corbits/react-ui";
import { useQuery } from "@tanstack/react-query";
import type { PrItem } from "../lib/hub-api.ts";
import { titleText } from "../lib/inbox-pane.ts";
import { ageText, listHref } from "../lib/inbox-view.ts";
import { relativeTime } from "../lib/duration.ts";
import { usePortal } from "../lib/portal.tsx";
import type { ResolvedPull } from "../lib/pulse.ts";
import { usePulse, type Pulse as PulseData } from "../lib/pulse-visit.tsx";
import type { RepoPackStore } from "../lib/repo-pack-store.ts";
import { useHubRepoPackStore } from "../lib/repo-pack.ts";
import { triageEnabledRepos } from "../lib/repo-rows.ts";
import { WEEK_DAYS, actedOn, medianText, repoStatsQuery } from "../lib/repo-stats.ts";
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

/** A resolved pull request has left the inbox, so it opens on GitHub. */
function ResolvedLine({ pull }: { pull: ResolvedPull }) {
  return (
    <li>
      <a href={`https://github.com/${pull.repo}/pull/${pull.number}`} target="_blank" rel="noreferrer">
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

function RepoWeek({ store, repo }: { store: RepoPackStore | null; repo: string }) {
  const { data: stats, isError } = useQuery(repoStatsQuery(store, repo, WEEK_DAYS));
  return (
    <tr>
      <th scope="row">{repo}</th>
      {stats ? (
        <>
          <td>{stats.triaged}</td>
          <td>{stats.neededYou}</td>
          <td>{actedOn(stats)}</td>
          <td>{medianText(stats.medianTimeToVerdictMs)}</td>
        </>
      ) : <td colSpan={4} className="note">{isError ? "Could not load this repository's numbers." : "Loading…"}</td>}
    </tr>
  );
}

function ThisWeek() {
  const { snapshot } = usePortal();
  const store = useHubRepoPackStore();
  const repos = useMemo(() => [...triageEnabledRepos(snapshot?.repos ?? [])].sort(), [snapshot]);
  return (
    <section aria-labelledby="pulse-week">
      <h2 id="pulse-week">This week, per repository</h2>
      {repos.length === 0 ? <p className="empty-line">No repository has triage on.</p> : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr><th scope="col">Repository</th><th scope="col">Triaged</th><th scope="col">Needed you</th><th scope="col">Acted on</th><th scope="col">Median to verdict</th></tr>
            </thead>
            <tbody>{repos.map((repo) => <RepoWeek key={repo} store={store} repo={repo} />)}</tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** A briefing beside the inbox: what changed since the last visit, what is stuck, and each repository's week. */
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
