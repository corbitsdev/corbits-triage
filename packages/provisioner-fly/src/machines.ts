import { type } from "arktype";

const API = "https://api.machines.dev/v1";
const REQUEST_TIMEOUT_MS = 90_000;
/** How long Fly holds a wait request open; inside REQUEST_TIMEOUT_MS. */
const WAIT_TIMEOUT_S = 60;

const Machine = type({ id: "string", state: "string", "config?": { "metadata?": "Record<string, string>" } });
const Machines = Machine.array();

export class FlyApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export type FlyMachine = {
  readonly id: string;
  readonly state: string;
  readonly metadata: Readonly<Record<string, string>>;
};

/** The body of a create request; https://fly.io/docs/machines/api/machines-resource/ has every field. */
export type FlyMachineSpec = {
  readonly region?: string;
  readonly config: {
    readonly image: string;
    readonly env: Readonly<Record<string, string>>;
    readonly metadata: Readonly<Record<string, string>>;
    readonly guest: { readonly cpu_kind: "shared" | "performance"; readonly cpus: number; readonly memory_mb: number };
    readonly restart: { readonly policy: "no" | "on-failure" | "always" };
    readonly auto_destroy: boolean;
  };
};

/** The Machines API calls the provisioner makes, all in one app. */
export type FlyMachines = {
  readonly app: string;
  /** The app's machines whose metadata holds every entry of `metadata`. Fly's listing can lag its machines. */
  list(metadata: Readonly<Record<string, string>>): Promise<FlyMachine[]>;
  /** Creates and starts a machine; resolves with its id. */
  create(spec: FlyMachineSpec): Promise<string>;
  /** Read by id, which unlike the listing is current at once; undefined once Fly no longer knows it. */
  get(id: string): Promise<FlyMachine | undefined>;
  /** Stops the machine if running and destroys it; one already gone counts as destroyed. */
  destroy(id: string): Promise<void>;
  /** Returns once the machine is destroyed or Fly no longer knows it. */
  waitDestroyed(id: string): Promise<void>;
};

export type FlyConnection = {
  /** A Fly API token, such as one from `fly tokens create deploy`. */
  readonly token: string;
  readonly app: string;
  readonly fetch?: typeof fetch;
};

function machineOf(value: typeof Machine.infer): FlyMachine {
  return { id: value.id, state: value.state, metadata: value.config?.metadata ?? {} };
}

export function connectFlyMachines({ token, app, fetch: send = fetch }: FlyConnection): FlyMachines {
  const base = `${API}/apps/${encodeURIComponent(app)}/machines`;

  async function request(method: string, path: string, body?: unknown): Promise<unknown> {
    const response = await send(`${base}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body !== undefined && { "Content-Type": "application/json" }) },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new FlyApiError(response.status, `Fly ${method} /apps/${app}/machines${path.split("?")[0]} failed (${String(response.status)}): ${text}`);
    }
    return text === "" ? null : JSON.parse(text);
  }

  async function unlessGone<T>(operation: Promise<T>): Promise<T | undefined> {
    try {
      return await operation;
    } catch (error) {
      if (error instanceof FlyApiError && error.status === 404) return undefined;
      throw error;
    }
  }

  return {
    app,
    async list(metadata) {
      const query = new URLSearchParams(Object.fromEntries(Object.entries(metadata).map(([key, value]) => [`metadata.${key}`, value])));
      return Machines.assert(await request("GET", `?${query.toString()}`)).map(machineOf);
    },
    async create(spec) {
      return Machine.assert(await request("POST", "", spec)).id;
    },
    async get(id) {
      const found = await unlessGone(request("GET", `/${id}`));
      return found === undefined ? undefined : machineOf(Machine.assert(found));
    },
    async destroy(id) {
      await unlessGone(request("DELETE", `/${id}?force=true`));
    },
    async waitDestroyed(id) {
      await unlessGone(request("GET", `/${id}/wait?state=destroyed&timeout=${String(WAIT_TIMEOUT_S)}`));
    },
  };
}
