import { useCallback, useState } from "react";
import { CommandPaletteInline, useCommandShortcut, type CommandPaletteGroup } from "@corbits/react-ui/ui/command-palette";
import type { RepoRecord } from "../../lib/hub-api.ts";
import { hostName } from "../../lib/pull-link.ts";
import { RepoIcon, UpDownIcon } from "../inbox-icons.tsx";

const RECENT_KEY = "code-review-recent";
const RECENT_MAX = 5;

export function repoKey(repo: Pick<RepoRecord, "name" | "source">): string {
  return `${repo.source}:${repo.name}`;
}

/** The repositories opened here lately, newest first; a browser that keeps nothing has none. */
export function readRecent(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENT_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function remember(key: string) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify([key, ...readRecent().filter((item) => item !== key)].slice(0, RECENT_MAX)));
  } catch {
    // A browser that keeps nothing lists no recent repositories.
  }
}

function groupsOf(repos: readonly RepoRecord[], query: string): CommandPaletteGroup[] {
  const needle = query.trim().toLowerCase();
  const shared = new Set(repos.filter((repo) => repos.some((other) => other.name === repo.name && other.source !== repo.source)).map((repo) => repo.name));
  function itemOf(repo: RepoRecord) {
    return { id: repoKey(repo), title: repo.name, ...(shared.has(repo.name) && { subtitle: hostName(repo.source) }) };
  }
  const matched = repos.filter((repo) => repo.name.toLowerCase().includes(needle));
  if (needle) return [{ id: "matches", heading: "Repositories", items: matched.map(itemOf) }];
  const recent = readRecent();
  const lately = recent.flatMap((key) => matched.filter((repo) => repoKey(repo) === key));
  const rest = matched.filter((repo) => !recent.includes(repoKey(repo)));
  const groups = [{ id: "recent", heading: "Recent", items: lately.map(itemOf) }, { id: "all", heading: "Repositories", items: rest.map(itemOf) }];
  return groups.filter((group) => group.items.length > 0);
}

type RepoSwitcherProps = { repos: readonly RepoRecord[]; selected: RepoRecord; onSelect: (repo: RepoRecord) => void };

/** The repository the page shows, switched by searching, with the arrow keys, from the recent ones, or with ⌘K. */
export function RepoSwitcher({ repos, selected, onSelect }: RepoSwitcherProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const toggle = useCallback(function toggle() {
    setOpen((was) => !was);
  }, []);
  useCommandShortcut(toggle);

  function openChange(next: boolean) {
    setOpen(next);
    if (!next) setQuery("");
  }

  function choose(key: string) {
    const repo = repos.find((item) => repoKey(item) === key);
    if (!repo) return;
    remember(key);
    onSelect(repo);
  }

  return (
    <CommandPaletteInline
      className="repo-switch"
      open={open}
      onOpenChange={openChange}
      query={query}
      onQueryChange={setQuery}
      groups={groupsOf(repos, query)}
      onSelect={choose}
      placeholder=""
      leading={(
        <button type="button" className="repo-switch-btn" aria-label={`Repository: ${selected.name}. Switch repository`} aria-expanded={open} onClick={() => openChange(!open)}>
          <RepoIcon />
          <b>{selected.name}</b>
          <UpDownIcon />
        </button>
      )}
    />
  );
}
