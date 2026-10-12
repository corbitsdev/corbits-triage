function storageKey(userId: string): string {
  return `corbits-triage:workspace:${userId}`;
}

/** The workspace the user last opened in this browser. */
export function readChosenWorkspace(userId: string): string | null {
  try {
    return localStorage.getItem(storageKey(userId));
  } catch {
    return null;
  }
}

export function writeChosenWorkspace(userId: string, tenantId: string) {
  try {
    localStorage.setItem(storageKey(userId), tenantId);
  } catch {
    // Storage can be blocked (private mode, quota); the choice then lasts until the next reload.
  }
}
