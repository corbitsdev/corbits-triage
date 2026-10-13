import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { getHubSession, signInHub, signOutHub, signUpHub, type HubUser } from "./hub-auth.ts";
import { hubConfigured } from "./hub-origin.ts";
import { announceSignOut, onSignOutElsewhere } from "./sign-out-channel.ts";

interface SessionContextValue {
  ready: boolean;
  session: HubUser | null;
  error: string;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, name?: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const SessionContext = createContext<SessionContextValue | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false);
  const [session, setSession] = useState<HubUser | null>(null);
  const [error, setError] = useState("");

  useEffect(function loadSession() {
    if (!hubConfigured()) {
      setReady(true);
      return;
    }
    let cancelled = false;
    async function run() {
      try {
        const value = await getHubSession();
        if (!cancelled) setSession(value?.user ?? null);
      } catch (cause: unknown) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setReady(true);
      }
    }
    void run();
    return function cancel() {
      cancelled = true;
    };
  }, []);

  useEffect(function signOutWithOtherTabs() {
    return onSignOutElsewhere(function signedOutElsewhere() {
      setSession(null);
      setError("");
    });
  }, []);

  const signIn = useCallback(async function signIn(email: string, password: string) {
    const user = await signInHub({ email, password });
    setSession(user);
    setError("");
  }, []);

  const signUp = useCallback(async function signUp(email: string, password: string, name?: string) {
    const user = await signUpHub({ email, password, name });
    setSession(user);
    setError("");
  }, []);

  const signOut = useCallback(async function signOut() {
    try {
      await signOutHub();
    } finally {
      setSession(null);
      announceSignOut();
    }
  }, []);

  return (
    <SessionContext.Provider value={{ ready, session, error, signIn, signUp, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession(): SessionContextValue {
  const value = useContext(SessionContext);
  if (!value) throw new Error("Session is unavailable.");
  return value;
}
