import { createContext, useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { browserTimers, createHoldQueue, HOLD_MS, type Notices } from "./held-actions.ts";
import type { PrGithubWriteInput } from "./hub-api.ts";
import type { NumberedItem, PaneDraft, PaneWrite } from "./inbox-pane.ts";
import { useHandledPulls, useMarkReplySent } from "./open-pulls.ts";
import { usePortal } from "./portal.tsx";
import { useSession } from "./session.tsx";

/** Drafts to put back, by pull request key, for the verdict they were written against. */
export type Restored = Record<string, { runId: string | null; draft: PaneDraft }>;

type HeldInbox = {
  notices: Notices;
  restored: Restored;
  /** `backTo` selects the pull request again when the action is undone. */
  hold: (item: NumberedItem, write: PaneWrite, draft: PaneDraft, backTo: () => void) => void;
  undo: () => boolean;
  forgetRestored: (key: string) => void;
  /** Marks the inbox as on screen; the returned function sends what is held as the inbox is left. */
  enter: () => () => void;
  /** Sends what is held and waits for every send, for when the session is about to end. */
  flush: () => Promise<void>;
};

const HeldInboxContext = createContext<HeldInbox | null>(null);

/**
 * Lives above the routes, so a send flushed as the inbox is left still reports how it went and a failed one's
 * draft is waiting when the user returns. While no inbox is on screen, results that need the user go to the portal's notify.
 */
export function HeldInboxProvider({ children }: { children: ReactNode }) {
  const { writeGithub, notify } = usePortal();
  const replySent = useMarkReplySent();
  const handledPulls = useHandledPulls();
  const [queue] = useState(() => createHoldQueue(browserTimers, HOLD_MS));
  const notices = useSyncExternalStore(queue.subscribe, queue.notices);
  const [restored, setRestored] = useState<Restored>({});
  const inboxes = useRef(0);

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
    if (inboxes.current === 0) notify(message);
    return message;
  }

  function hold(item: NumberedItem, write: PaneWrite, draft: PaneDraft, backTo: () => void) {
    function writeHeld(input: PrGithubWriteInput) {
      return writeGithub(input, "held");
    }
    function writeLeaving(input: PrGithubWriteInput) {
      return writeGithub(input, "leaving");
    }
    function restore() {
      if (!write.stay) handledPulls.release(item);
      write.restore?.();
      setRestored((current) => ({ ...current, [item.key]: { runId: item.runId, draft } }));
    }
    if (!write.stay) handledPulls.hold(item);
    queue.hold({
      pending: write.pending,
      async send(leaving) {
        if (!write.stay) handledPulls.markHandled(item);
        const outcome = await write.send({ write: leaving ? writeLeaving : writeHeld, replySent });
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

export function useHeldInbox(): HeldInbox {
  const value = useContext(HeldInboxContext);
  if (value === null) throw new Error("useHeldInbox must be used inside HeldInboxProvider.");
  return value;
}
