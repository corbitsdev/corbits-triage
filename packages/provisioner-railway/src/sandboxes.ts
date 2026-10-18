import { setTimeout as sleep } from "node:timers/promises";
import { DEFAULT_RAILWAY_GRAPHQL_ENDPOINT, Sandbox, type ConnectOptions, type SandboxStatus } from "railway";

/** Where the template checks out the repository, matching the hub image's root. */
const SIDECAR_ROOT = "/app";
/** Bun's official Linux x64 release, checked against its published SHA-256. */
const BUN = {
  url: "https://github.com/oven-sh/bun/releases/download/bun-v1.4.2/bun-linux-x64.zip",
  sha256: "36368faef7527875d5ffa52e53cd48021741f2a83eb6208a8dd64068d422a913",
} as const;
/** Derived by the SDK from the default endpoint; passed explicitly so no environment variable can move it. */
const EXEC_ENDPOINT = "wss://ssh.railway.com:2226/ws/exec";
const PAGE_SIZE = 100;
const POLL_MS = 1_000;
const RUNNING_WAIT_MS = 5 * 60_000;
const DESTROY_WAIT_MS = 60_000;
const TEMPLATE_WAIT_MS = 30 * 60_000;

export type SandboxSummary = { readonly id: string; readonly status: SandboxStatus };

/** Railway refused to create a sandbox for good, such as for its token, plan or input, so none exists. */
export class RailwayCreateRefused extends Error {}

/** The Railway calls the provisioner makes, all in one environment. */
export type RailwaySandboxes = {
  /** Every sandbox in the environment, destroyed ones included. */
  list(): Promise<readonly SandboxSummary[]>;
  /** The named create-time variables of a running sandbox, or undefined when any is unset or the sandbox is gone. */
  readVariables(id: string, names: readonly string[]): Promise<Readonly<Record<string, string>> | undefined>;
  /** Asks for a sandbox from the sidecar template, with `variables` in every command's environment; it may not run yet. */
  create(variables: Readonly<Record<string, string>>): Promise<string>;
  waitUntilRunning(id: string): Promise<void>;
  /** Starts the sidecar in the background, with `env` on its process only. */
  launch(id: string, env: Readonly<Record<string, string>>): Promise<void>;
  /** Returns once the sandbox is destroyed or was never there. */
  destroy(id: string): Promise<void>;
  /** Resolves once the sidecar template is built. The first call starts the build; after a failed one, the next call starts another. */
  templateReady(): Promise<void>;
};

export type SidecarTemplateSource = {
  /** A public git repository holding `commit`. */
  readonly repository: string;
  readonly commit: string;
};

/** The repository at the hub's commit, installed at SIDECAR_ROOT as in the hub image, with a pinned Bun. */
export function sidecarTemplate({ repository, commit }: SidecarTemplateSource): readonly string[] {
  return [
    "apt-get update && apt-get install -y --no-install-recommends unzip",
    `curl -fsSLo /tmp/bun.zip ${BUN.url} && echo "${BUN.sha256}  /tmp/bun.zip" | sha256sum -c - && unzip -q /tmp/bun.zip -d /tmp && install -m 0755 /tmp/bun-linux-x64/bun /usr/local/bin/bun && rm -rf /tmp/bun.zip /tmp/bun-linux-x64`,
    `git init ${SIDECAR_ROOT} && git -C ${SIDECAR_ROOT} fetch --depth 1 ${repository} ${commit} && git -C ${SIDECAR_ROOT} checkout FETCH_HEAD`,
    `cd ${SIDECAR_ROOT} && bun install --frozen-lockfile`,
  ];
}

export type RailwayConnection = {
  /** A workspace or account token, sent as a bearer token. */
  readonly token: string;
  readonly environmentId: string;
  readonly fetch?: typeof fetch;
};

type GraphQLError = { readonly message: string };
type GraphQLBody = { readonly data?: unknown; readonly errors?: readonly GraphQLError[] };

/** Railway refused the operation for good: trying it again unchanged gets the same answer. */
class RailwayRefusal extends Error {}

async function bodyOf(response: Response): Promise<GraphQLBody> {
  try {
    return (await response.json()) as GraphQLBody;
  } catch {
    // An error page from a proxy in front of Railway, for example; the status says what happened.
    return {};
  }
}

/** Too many requests or a server error may pass; anything else Railway refused is final. */
function isTransient(status: number): boolean {
  return status === 429 || status >= 500;
}

const SANDBOX_FIELDS = "id status";

type Page = { sandboxes: { edges: Array<{ node: SandboxSummary }>; pageInfo: { hasNextPage: boolean; endCursor: string | null } } };
type Build = { sandboxTemplateBuild: { id: string; status: string } };

function isGone(status: SandboxStatus | undefined): boolean {
  return status === undefined || status === "DESTROYED";
}

/** Railway's GraphQL API at its default endpoint, and its exec bridge, whatever the hub's environment says. */
export function connectRailwaySandboxes(connection: RailwayConnection, instructions: readonly string[]): RailwaySandboxes {
  const send = connection.fetch ?? fetch;
  const execOptions: ConnectOptions = {
    token: connection.token,
    authType: "bearer",
    endpoint: DEFAULT_RAILWAY_GRAPHQL_ENDPOINT,
    tcpProxyWsEndpoint: EXEC_ENDPOINT,
    verbose: false,
    environmentId: connection.environmentId,
  };

  async function graphql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await send(DEFAULT_RAILWAY_GRAPHQL_ENDPOINT, {
      method: "POST",
      headers: { Accept: "application/json", Authorization: `Bearer ${connection.token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ query, variables: { environmentId: connection.environmentId, ...variables } }),
    });
    const body = await bodyOf(response);
    const [error] = body.errors ?? [];
    const detail = error === undefined ? response.statusText : error.message;
    const message = `Railway answered HTTP ${String(response.status)}: ${detail}`;
    if (isTransient(response.status)) throw new Error(message);
    if (error !== undefined || !response.ok) throw new RailwayRefusal(message);
    if (body.data === undefined) throw new Error(message);
    return body.data as T;
  }

  async function status(id: string): Promise<SandboxStatus | undefined> {
    const { sandbox } = await graphql<{ sandbox: SandboxSummary | null }>(
      `query($environmentId: String!, $id: String!) { sandbox(environmentId: $environmentId, id: $id) { ${SANDBOX_FIELDS} } }`,
      { id },
    );
    return sandbox?.status;
  }

  async function waitFor(what: string, deadlineMs: number, done: () => Promise<boolean>): Promise<void> {
    const deadline = Date.now() + deadlineMs;
    while (!(await done())) {
      if (Date.now() >= deadline) throw new Error(`Railway: ${what} did not happen within ${String(deadlineMs)} ms`);
      await sleep(POLL_MS);
    }
  }

  async function buildTemplate(): Promise<void> {
    const { sandboxTemplateBuild: build } = await graphql<Build>(
      `mutation($environmentId: String!, $input: SandboxTemplateInput!) { sandboxTemplateBuild(environmentId: $environmentId, input: $input) { id status } }`,
      { input: { instructions } },
    );
    await waitFor(`template build ${build.id}`, TEMPLATE_WAIT_MS, async function ready() {
      const { sandboxTemplateBuild } = await graphql<Build>(
        `query($environmentId: String!, $id: ID!) { sandboxTemplateBuild(environmentId: $environmentId, id: $id) { id status } }`,
        { id: build.id },
      );
      if (sandboxTemplateBuild.status === "FAILED") throw new Error(`Railway template build ${build.id} failed`);
      return sandboxTemplateBuild.status === "READY";
    });
  }

  let built: Promise<void> | undefined;

  async function buildOnce(): Promise<void> {
    try {
      await buildTemplate();
    } catch (error) {
      built = undefined;
      throw error;
    }
  }

  function templateReady(): Promise<void> {
    built ??= buildOnce();
    return built;
  }

  async function connect(id: string): Promise<Sandbox> {
    return Sandbox.connect(id, execOptions);
  }

  return {
    async list() {
      const sandboxes: SandboxSummary[] = [];
      let after: string | null = null;
      do {
        const page: Page = await graphql<Page>(
          `query($environmentId: String!, $first: Int, $after: String) { sandboxes(environmentId: $environmentId, first: $first, after: $after) { edges { node { ${SANDBOX_FIELDS} } } pageInfo { hasNextPage endCursor } } }`,
          { first: PAGE_SIZE, after },
        );
        sandboxes.push(...page.sandboxes.edges.map((edge) => edge.node));
        after = page.sandboxes.pageInfo.hasNextPage ? page.sandboxes.pageInfo.endCursor : null;
      } while (after !== null);
      return sandboxes;
    },
    async readVariables(id, names) {
      if (isGone(await status(id))) return undefined;
      const sandbox = await connect(id);
      const { exitCode, stdout, timedOut } = await sandbox.execHttp(`printenv ${names.join(" ")}`, { timeoutSec: 30 });
      // printenv exits 1 for an unset name; any other failure says nothing about whose the sandbox is.
      if (exitCode === 1 && !timedOut) return undefined;
      if (exitCode !== 0) throw new Error(`Reading Railway sandbox ${id}'s variables failed with exit code ${String(exitCode)}`);
      const values = stdout.split("\n");
      return Object.fromEntries(names.map(function pair(name, index) {
        const value = values[index];
        if (value === undefined) throw new Error(`Railway sandbox ${id} printed no value for ${name}`);
        return [name, value];
      }));
    },
    async create(variables) {
      try {
        const { sandboxCreate } = await graphql<{ sandboxCreate: SandboxSummary }>(
          `mutation($input: SandboxCreateInput!) { sandboxCreate(input: $input) { ${SANDBOX_FIELDS} } }`,
          {
            input: {
              environmentId: connection.environmentId,
              template: { instructions },
              variables,
              // The hub decides when a sidecar ends; an idle one waits for work.
              idleTimeoutMinutes: 0,
              networkIsolation: "ISOLATED",
            },
          },
        );
        return sandboxCreate.id;
      } catch (error) {
        if (!(error instanceof RailwayRefusal)) throw error;
        throw new RailwayCreateRefused(error.message);
      }
    },
    async waitUntilRunning(id) {
      await waitFor(`sandbox ${id} running`, RUNNING_WAIT_MS, async function running() {
        const current = await status(id);
        if (current === "RUNNING") return true;
        if (current !== "CREATING") throw new Error(`Railway sandbox ${id} is ${current ?? "gone"} instead of running`);
        return false;
      });
    },
    async launch(id, env) {
      const sandbox = await connect(id);
      const handle = sandbox.exec('mkdir -p "$SIDECAR_DATA_DIR" && exec bun --conditions=intx-src apps/sidecar/src/index.ts', {
        cwd: `${SIDECAR_ROOT}/vendor/interchange`,
        env: { ...env },
        captureOutput: false,
      });
      await handle.detach();
    },
    async destroy(id) {
      const current = await status(id);
      if (isGone(current)) return;
      if (current !== "DESTROYING") {
        await graphql(`mutation($environmentId: String!, $id: String!) { sandboxDestroy(environmentId: $environmentId, id: $id) { ${SANDBOX_FIELDS} } }`, { id });
      }
      await waitFor(`sandbox ${id} destroyed`, DESTROY_WAIT_MS, async function destroyed() {
        return isGone(await status(id));
      });
    },
    templateReady,
  };
}
