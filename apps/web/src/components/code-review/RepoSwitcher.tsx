import { useState, type KeyboardEvent } from "react";
import { Input } from "@corbits/react-ui";
import type { RepoRecord } from "../../lib/hub-api.ts";

const RECENT = "code-review-recent";

export function repoKey(repo: RepoRecord): string {
  return `${repo.source}:${repo.name}`;
}

function readRecent(): string[] {
  try {
    const raw = localStorage.getItem(RECENT);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function remember(key: string) {
  const next = [key, ...readRecent().filter((item) => item !== key)].slice(0, 5);
  localStorage.setItem(RECENT, JSON.stringify(next));
}

type RepoSwitcherProps = { repos: readonly RepoRecord[]; selected: RepoRecord | undefined; onSelect: (repo: RepoRecord) => void };

/** Search, arrow keys and the repositories opened lately. */
export function RepoSwitcher({ repos, selected, onSelect }: RepoSwitcherProps) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const recent = readRecent();
  const needle = query.trim().toLowerCase();
  const matched = repos.filter((repo) => repo.name.toLowerCase().includes(needle));
  const listed = needle ? matched : [...matched].sort(function byRecent(a, b) {
    function rank(key: string): number {
      const at = recent.indexOf(key);
      return at < 0 ? recent.length : at;
    }
    return rank(repoKey(a)) - rank(repoKey(b)) || a.name.localeCompare(b.name);
  });
  function sharedName(repo: RepoRecord): boolean {
    return repos.some((other) => other.name === repo.name && other.source !== repo.source);
  }

  function choose(repo: RepoRecord) {
    remember(repoKey(repo));
    setQuery("");
    setOpen(false);
    onSelect(repo);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setOpen(true);
      setHighlight((at) => Math.min(at + 1, Math.max(listed.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setOpen(true);
      setHighlight((at) => Math.max(at - 1, 0));
      return;
    }
    if (event.key === "Enter" && open && listed[highlight]) {
      event.preventDefault();
      choose(listed[highlight]);
      return;
    }
    if (event.key === "Escape") setOpen(false);
  }

  function label(repo: RepoRecord): string {
    return sharedName(repo) ? `${repo.name} (${repo.source === "github" ? "GitHub" : "Bitbucket"})` : repo.name;
  }

  return (
    <div className="repo-switch">
      <Input
        value={open ? query : selected?.name ?? ""}
        placeholder="Repository"
        aria-label="Repository"
        aria-expanded={open}
        aria-controls="repo-choices"
        role="combobox"
        onFocus={() => setOpen(true)}
        onChange={(event) => { setQuery(event.target.value); setOpen(true); setHighlight(0); }}
        onKeyDown={onKeyDown}
      />
      {open ? (
        <ul id="repo-choices" role="listbox" aria-label="Repositories">
          {listed.map((repo, at) => (
            <li key={repoKey(repo)} role="option" aria-selected={at === highlight}>
              <button type="button" className={at === highlight ? "on" : undefined} onMouseDown={(event) => event.preventDefault()} onClick={() => choose(repo)}>{label(repo)}</button>
            </li>
          ))}
          {listed.length === 0 ? <li className="empty">No repository matches.</li> : null}
        </ul>
      ) : null}
    </div>
  );
}
