import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from "react";
import { IsRestoringProvider, useQueryClient } from "@tanstack/react-query";
import type { AsyncStorage } from "@tanstack/react-query-persist-client";
import { del, get, set } from "idb-keyval";
import { createUserCache, sessionState } from "./query-persistence.ts";
import { useSession } from "./session.tsx";

/** Visits saved by the old Pulse page hold pull request titles, so a browser that kept them drops them at sign-out. */
const PULSE_VISIT_PREFIX = "corbits-triage:pulse:";

function forgetSavedVisits(storage: Storage) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) {
    if (key?.startsWith(PULSE_VISIT_PREFIX)) storage.removeItem(key);
  }
}

const idbStorage: AsyncStorage<string> = { getItem: get, setItem: set, removeItem: del };

export function UserQueryCache({ children }: { children: ReactNode }) {
  const { ready, session, error } = useSession();
  const queryClient = useQueryClient();
  const [cache] = useState(() => createUserCache(queryClient, idbStorage));
  const userId = session?.id ?? null;
  const state = useMemo(() => sessionState(ready, userId, error), [ready, userId, error]);
  const restored = useSyncExternalStore(cache.subscribe, cache.restoredUser);

  useEffect(function followSession() {
    if (state.kind === "signed-out") {
      try {
        forgetSavedVisits(localStorage);
      } catch {
        // Storage can be blocked (private mode); nothing was saved then.
      }
    }
    void cache.update(state);
    return cache.stop;
  }, [cache, state]);

  return <IsRestoringProvider value={userId !== null && restored !== userId}>{children}</IsRestoringProvider>;
}
