const CHANNEL_NAME = "corbits.session";
const STORAGE_KEY = "corbits.signed-out";

/** Tells the portal's other tabs that this browser signed out, so they drop the user's data too. */
export function announceSignOut() {
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.postMessage("signed-out");
    channel.close();
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, String(Date.now()));
  } catch {
    // Storage can be blocked (private mode); other tabs then sign out on their next 401.
  }
}

export function onSignOutElsewhere(listener: () => void): () => void {
  if (typeof BroadcastChannel === "function") {
    const channel = new BroadcastChannel(CHANNEL_NAME);
    channel.onmessage = listener;
    return function stopListening() {
      channel.close();
    };
  }
  function onStorage(event: StorageEvent) {
    if (event.key === STORAGE_KEY) listener();
  }
  window.addEventListener("storage", onStorage);
  return function stopListening() {
    window.removeEventListener("storage", onStorage);
  };
}
