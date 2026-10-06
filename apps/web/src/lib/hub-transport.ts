import { ApiError, type Transport } from "@intx/hub-client";
import { requestOrigin } from "./hub-origin.ts";

export type { Transport };
export { ApiError };

const ALLOWED_EVENT_NAMES = new Set(["message", "snapshot", "status"]);

function assertAllowedEventName(eventName: string | undefined): string {
  const name = eventName ?? "message";
  if (!ALLOWED_EVENT_NAMES.has(name)) {
    throw new ApiError(0, "event_rejected", `Rejected SSE event "${name}".`);
  }
  return name;
}

export function createHubTransport(): Transport {
  return {
    async fetch<T>(method: string, path: string, body?: unknown): Promise<T> {
      let response: Response;
      try {
        const init: RequestInit = { method, credentials: "include" };
        if (body !== undefined) {
          init.headers = { "content-type": "application/json" };
          init.body = JSON.stringify(body);
        }
        response = await fetch(`${requestOrigin()}${path}`, init);
      } catch {
        throw new ApiError(
          0,
          "host_unreachable",
          "The hub is unreachable. Auto-advance is denied.",
        );
      }
      if (response.status === 204) return undefined as T;
      const text = await response.text();
      let parsed: unknown;
      try {
        parsed = text.length === 0 ? undefined : JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      if (!response.ok) {
        const detail = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error;
        throw new ApiError(
          response.status,
          detail?.code ?? "unknown",
          detail?.message ?? `HTTP ${response.status}`,
        );
      }
      return parsed as T;
    },
    subscribe(path: string, onEvent: (event: unknown) => void, opts?: { eventName?: string }): () => void {
      const eventName = assertAllowedEventName(opts?.eventName);
      const source = new EventSource(`${requestOrigin()}${path}`, { withCredentials: true });
      function handler(event: Event) {
        const data = (event as MessageEvent<string>).data;
        if (typeof data !== "string" || data.length === 0) return;
        let parsed: unknown;
        try {
          parsed = JSON.parse(data);
        } catch {
          return;
        }
        if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
        onEvent(parsed);
      }
      source.addEventListener(eventName, handler);
      return () => source.close();
    },
  };
}
