import { useCallback, useEffect, useRef } from "react";

type GithubReturnSyncState = {
  awaitingReturn: boolean;
};

function armGithubReturnSync(): GithubReturnSyncState {
  return { awaitingReturn: true };
}

function consumeGithubReturnSync(): GithubReturnSyncState {
  return { awaitingReturn: false };
}

function shouldSyncAfterGithubReturn(input: {
  awaitingReturn: boolean;
  visible: boolean;
}): boolean {
  return input.awaitingReturn && input.visible;
}

export function useGithubReturnSync(onReturn: () => void): { arm: () => void } {
  const stateRef = useRef<GithubReturnSyncState>(consumeGithubReturnSync());
  const ignoreSameTurnRef = useRef(false);
  const onReturnRef = useRef(onReturn);
  onReturnRef.current = onReturn;

  const arm = useCallback(function arm() {
    stateRef.current = armGithubReturnSync();
    ignoreSameTurnRef.current = true;
    queueMicrotask(function endSameTurn() {
      ignoreSameTurnRef.current = false;
    });
  }, []);

  useEffect(function listenForGithubReturn() {
    function maybeSync(visible: boolean) {
      if (ignoreSameTurnRef.current) return;
      if (!shouldSyncAfterGithubReturn({
        awaitingReturn: stateRef.current.awaitingReturn,
        visible,
      })) return;
      stateRef.current = consumeGithubReturnSync();
      onReturnRef.current();
    }

    function onVisibilityChange() {
      maybeSync(document.visibilityState === "visible");
    }

    function onWindowFocus() {
      maybeSync(true);
    }

    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("focus", onWindowFocus);
    return function stopListening() {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("focus", onWindowFocus);
    };
  }, []);

  return { arm };
}
