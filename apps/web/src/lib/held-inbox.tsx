import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useNavigate } from "react-router-dom";
import { browserTimers, createHoldQueue, HOLD_MS, type Notices } from "./held-actions.ts";
import { useApproveDo } from "./held-dos.ts";
import type { HeldDoRef, PrGithubWriteInput } from "./hub-api.ts";
import type { NumberedItem, PaneDraft, PaneWrite } from "./inbox-pane.ts";
import { useHandledPulls, useMarkReplySent } from "./open-pulls.ts";
import { usePortal } from "./portal.tsx";
import { useSession } from "./session.tsx";

export type Restored = Record<string, { runId: string | null; draft: PaneDraft }>;

type HeldInbox = {
  notices: Notices;
  restored: Restored;
  /** `backTo` selects the pull request again when the action is undone. */
  hold: (item: NumberedItem, write: PaneWrite, draft: PaneDraft, backTo: () => void) => void;
  undo: () => boolean;
  forgetRestored: (key: string) => void;
  enter: () => () => void;
  flush: () => Promise<void>;
};

const HeldInboxContext = createContext<HeldInbox | null>(null);

/**
 * Lives above the routes, so a send flushed as the inbox is left still reports how it went and a failed one's
 * draft is waiting when the user returns. While no inbox is on screen, results that need the user go to the portal's warn toast.
 */
export function HeldInboxProvider({ children }: { children: ReactNode }) {
  const { writeGithub, warn } = usePortal();
  const { session } = useSession();
  const userId = session?.id ?? null;
  const sessionUser = useRef(userId);
  const replySent = useMarkReplySent();
  const handledPulls = useHandledPulls();
  const approveDo = useApproveDo();
  const [queue] = useState(() => createHoldQueue(browserTimers, HOLD_MS));
  const notices = useSyncExternalStore(queue.subscribe, queue.notices);
  const [restored, setRestored] = useState<Restored>({});
  const inboxes = useRef(0);

  // Explicit sign-out sends what is held first; a session that ends otherwise (a 401, another tab) cannot send it, so it is dropped.
  useEffect(function dropWhenSessionChanges() {
    sessionUser.current = userId;
    return function dropHeld() {
      queue.drop();
      setRestored({});
    };
  }, [queue, userId]);

  useEffect(function sendHeldWhenPageGoes() {
    function onPageHide() {
      void queue.flush();
    }
    function onVisibilityChange() {
      if (document.visibilityState === "hidden") void queue.flush();
    }
    window.addEventListener("pagehide", onPageHide);
    document.addEventListener("visibilitychange", onVisibilityChange);
    return function stopListening() {
      window.removeEventListener("pagehide", onPageHide);
      document.removeEventListener("visibilitychange", onVisibilityChange);
    };
  }, [queue]);

  function tellIfAway(message: string): string {
    if (inboxes.current === 0) warn(message);
    return message;
  }

  function hold(item: NumberedItem, write: PaneWrite, draft: PaneDraft, backTo: () => void) {
    function writeHeld(input: PrGithubWriteInput) {
      return writeGithub(input, "held");
    }
    function writeLeaving(input: PrGithubWriteInput) {
      return writeGithub(input, "leaving");
    }
    const heldBy = sessionUser.current;
    function restore() {
      if (sessionUser.current !== heldBy) return;
      if (write.settles !== null) handledPulls.release(item);
      write.restore?.();
      setRestored((current) => ({ ...current, [item.key]: { runId: item.runId, draft } }));
    }
    const settles = write.settles;
    if (settles !== null) handledPulls.hold(item, settles);
    queue.hold({
      pending: write.pending,
      async send(leaving) {
        if (settles !== null) handledPulls.markHandled(item, settles);
        function approveHeldDo(ref: HeldDoRef) {
          return approveDo(ref, leaving);
        }
        const outcome = await write.send({ write: leaving ? writeLeaving : writeHeld, replySent, approveDo: approveHeldDo });
        if (settles !== null) handledPulls.sent(settles);
        if (!outcome.complete) tellIfAway(outcome.message);
        return outcome;
      },
      undo() {
        restore();
        backTo();
      },
      restore,
      failText(error) {
        return tellIfAway(`#${item.number} was not sent to GitHub and is back in your inbox. ${error}`);
      },
    });
  }

  const forgetRestored = useCallback(function forgetRestored(key: string) {
    setRestored((current) => Object.fromEntries(Object.entries(current).filter(([restoredKey]) => restoredKey !== key)));
  }, []);

  const enter = useCallback(function enter() {
    inboxes.current += 1;
    return function leaveInbox() {
      inboxes.current -= 1;
      void queue.flush();
    };
  }, [queue]);

  const value: HeldInbox = { notices, restored, hold, undo: queue.undo, forgetRestored, enter, flush: queue.flush };
  return <HeldInboxContext.Provider value={value}>{children}</HeldInboxContext.Provider>;
}

/** Signing out ends the session the held writes need, so they are sent first. */
export function useSignOutAfterSending(): () => Promise<void> {
  const { flush } = useHeldInbox();
  const { signOut } = useSession();
  return useCallback(async function signOutAfterSending() {
    await flush();
    await signOut();
  }, [flush, signOut]);
}

export function useOpenWorkspaceAfterSending(): (tenantId: string, path?: string) => Promise<void> {
  const { flush } = useHeldInbox();
  const { openWorkspace } = usePortal();
  const navigate = useNavigate();
  return useCallback(async function openWorkspaceAfterSending(tenantId: string, path = "/") {
    await flush();
    openWorkspace(tenantId);
    navigate(path);
  }, [flush, navigate, openWorkspace]);
}

export function useHeldInbox(): HeldInbox {
  const value = useContext(HeldInboxContext);
  if (value === null) throw new Error("useHeldInbox must be used inside HeldInboxProvider.");
  return value;
}
