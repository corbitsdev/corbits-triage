import type { QueryClient } from "@tanstack/react-query";
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister";
import {
  persistQueryClientRestore,
  persistQueryClientSubscribe,
  type AsyncStorage,
  type PersistQueryClientOptions,
  type Persister,
} from "@tanstack/react-query-persist-client";
import { isPersistedQuery } from "./persisted-queries.ts";

const PERSISTED_QUERIES_KEY = "corbits.queries";
const PERSISTED_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
/** Changed whenever a persisted query's shape changes, so older caches are dropped rather than read as the new shape. */
const PERSISTED_SHAPE = "renamed-rule-ids";

export type SessionState = { kind: "unknown" } | { kind: "signed-out" } | { kind: "signed-in"; userId: string };

/** A session check that failed says nothing about who is signed in, so only a known signed-out state clears data. */
export function sessionState(ready: boolean, userId: string | null, error: string): SessionState {
  if (userId !== null) return { kind: "signed-in", userId };
  return ready && error === "" ? { kind: "signed-out" } : { kind: "unknown" };
}

/**
 * Reads and writes pass only while `current` holds. Saves are throttled, so one queued before sign-out is skipped
 * rather than writing the data back, and a read finishing after sign-out is not hydrated.
 */
function userPersister(storage: AsyncStorage<string>, current: () => boolean): Persister {
  async function getWhileCurrent(key: string) {
    const value = await storage.getItem(key);
    return current() ? value : null;
  }
  async function setWhileCurrent(key: string, value: string) {
    if (current()) await storage.setItem(key, value);
  }
  return createAsyncStoragePersister({
    storage: { getItem: getWhileCurrent, setItem: setWhileCurrent, removeItem: storage.removeItem },
    key: PERSISTED_QUERIES_KEY,
  });
}

function never(): boolean {
  return false;
}

export type UserCache = {
  update: (state: SessionState) => Promise<void>;
  /** The user whose stored cache has been restored, so queries may fetch. */
  restoredUser: () => string | null;
  subscribe: (listener: () => void) => () => void;
  /** Stops persisting without clearing anything, for when the session being followed changes or the app unmounts. */
  stop: () => void;
};

/**
 * Keeps the query cache in storage for the signed-in user only. The buster carries the user, so another user's stored
 * cache is dropped on restore rather than shown; signing out removes the in-memory and the stored cache.
 */
export function createUserCache(queryClient: QueryClient, storage: AsyncStorage<string>): UserCache {
  const listeners = new Set<() => void>();
  let active: { userId: string } | null = null;
  /** Whose data the in-memory cache holds; unlike `active` it outlives `stop`. */
  let holder: string | null = null;
  let restored: string | null = null;
  let unsubscribe: (() => void) | null = null;

  function setRestored(userId: string | null) {
    restored = userId;
    for (const listener of listeners) listener();
  }

  function stop() {
    unsubscribe?.();
    unsubscribe = null;
    active = null;
    setRestored(null);
  }

  async function signOut() {
    stop();
    holder = null;
    queryClient.clear();
    await userPersister(storage, never).removeClient();
  }

  async function signIn(userId: string) {
    if (active?.userId === userId) return;
    if (holder !== null && holder !== userId) await signOut();
    const mine = { userId };
    active = mine;
    holder = userId;
    const options: PersistQueryClientOptions = {
      queryClient,
      persister: userPersister(storage, () => active === mine),
      maxAge: PERSISTED_MAX_AGE_MS,
      buster: `${PERSISTED_SHAPE}:${userId}`,
      dehydrateOptions: { shouldDehydrateQuery: isPersistedQuery },
    };
    try {
      await persistQueryClientRestore(options);
    } catch {
      // Restore removes a stored cache it cannot read, so the user starts empty.
    }
    if (active !== mine) return;
    unsubscribe = persistQueryClientSubscribe(options);
    setRestored(userId);
  }

  async function update(state: SessionState) {
    if (state.kind === "signed-in") await signIn(state.userId);
    if (state.kind === "signed-out") await signOut();
  }

  function subscribe(listener: () => void) {
    listeners.add(listener);
    return function unsubscribeListener() {
      listeners.delete(listener);
    };
  }

  return { update, restoredUser: () => restored, subscribe, stop };
}
