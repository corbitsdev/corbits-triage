import { useState } from "react";
import { useMediaQuery } from "./media-query.ts";
import { useSession } from "./session.tsx";

export type DiffLayout = "stacked" | "split";

// Split needs two readable columns; narrower screens always get stacked.
const SPLIT_QUERY = "(min-width: 721px)";

function storageKey(userId: string): string {
  return `corbits-triage:diff-layout:${userId}`;
}

function readLayout(userId: string): DiffLayout {
  try {
    return localStorage.getItem(storageKey(userId)) === "split" ? "split" : "stacked";
  } catch {
    return "stacked";
  }
}

function writeLayout(userId: string, layout: DiffLayout) {
  try {
    localStorage.setItem(storageKey(userId), layout);
  } catch {
    // Storage can be blocked (private mode, quota); the choice then lasts for this page only.
  }
}

export function useDiffLayout() {
  const { session } = useSession();
  if (!session) throw new Error("The diff layout needs a signed-in user.");
  const userId = session.id;
  const [stored, setStored] = useState(() => ({ userId, layout: readLayout(userId) }));
  const layout = stored.userId === userId ? stored.layout : readLayout(userId);
  const fits = useMediaQuery(SPLIT_QUERY);
  function choose(next: DiffLayout) {
    setStored({ userId, layout: next });
    writeLayout(userId, next);
  }
  return { layout, splitFits: fits, choose };
}
