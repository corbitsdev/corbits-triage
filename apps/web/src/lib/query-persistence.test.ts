import { expect, test } from "bun:test";
import { QueryClient, QueryObserver } from "@tanstack/react-query";
import type { AsyncStorage } from "@tanstack/react-query-persist-client";
import { createUserCache, sessionState } from "./query-persistence.ts";

const OPEN = { repos: [{ repo: "o/r", prs: [{ number: 1, title: "A's pull request" }] }] };
const OPEN_KEY = ["open-pulls", "t1"];
const THROTTLE_MS = 1_000;

function memoryStorage(): AsyncStorage<string> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return {
    items,
    getItem: (key) => items.get(key),
    setItem: (key, value) => items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
}

async function storedFor(userId: string, storage = memoryStorage()) {
  const queryClient = new QueryClient();
  const cache = createUserCache(queryClient, storage);
  await cache.update(sessionState(true, userId, ""));
  queryClient.setQueryData(OPEN_KEY, OPEN);
  await Bun.sleep(THROTTLE_MS + 100);
  return { queryClient, cache, storage };
}

test("a failed session check keeps the cache", async () => {
  const { queryClient, cache, storage } = await storedFor("a");

  await cache.update(sessionState(true, null, "HTTP 502"));

  expect(queryClient.getQueryData<typeof OPEN>(OPEN_KEY)).toEqual(OPEN);
  expect(storage.items.get("corbits.queries")).toContain("A's pull request");
});

test("signing out, or the hub having no session, removes the in-memory and the stored cache", async () => {
  const { queryClient, cache, storage } = await storedFor("a");

  await cache.update(sessionState(true, null, ""));

  expect(queryClient.getQueryCache().getAll().map((query) => query.state.data)).toEqual([undefined]);
  expect(storage.items.size).toBe(0);
});

test("a save queued before sign-out is not written back", async () => {
  const { queryClient, cache, storage } = await storedFor("a");
  queryClient.setQueryData(["open-pulls", "t2"], OPEN);

  await cache.update(sessionState(true, null, ""));
  await Bun.sleep(THROTTLE_MS + 100);

  expect(storage.items.size).toBe(0);
});

test("a cache stored for one user is dropped, not restored, for another", async () => {
  const { storage } = await storedFor("a");

  const other = new QueryClient();
  await createUserCache(other, storage).update(sessionState(true, "b", ""));

  expect(other.getQueryData(OPEN_KEY)).toBeUndefined();
  expect(storage.items.size).toBe(0);
});

test("the same user's stored cache is restored", async () => {
  const { storage } = await storedFor("a");

  const again = new QueryClient();
  await createUserCache(again, storage).update(sessionState(true, "a", ""));

  expect(again.getQueryData<typeof OPEN>(OPEN_KEY)).toEqual(OPEN);
});

async function signInOptionsAfterSignOut(queryClient: QueryClient, cache: ReturnType<typeof createUserCache>) {
  const observer = new QueryObserver(queryClient, { queryKey: ["auth-methods"], queryFn: async () => ({ google: true }) });
  const settled = new Promise((resolve) => {
    observer.subscribe((result) => result.isSuccess && resolve(result.data));
  });
  await cache.update(sessionState(true, null, ""));
  return settled;
}

test("the sign-in options a signed-out screen loads survive the sign-out, on a first visit and after a user", async () => {
  const fresh = new QueryClient();
  expect(await signInOptionsAfterSignOut(fresh, createUserCache(fresh, memoryStorage()))).toEqual({ google: true });

  const { queryClient, cache } = await storedFor("a");
  expect(await signInOptionsAfterSignOut(queryClient, cache)).toEqual({ google: true });
  expect(queryClient.getQueryData(OPEN_KEY)).toBeUndefined();
});
