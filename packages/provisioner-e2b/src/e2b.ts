import { Sandbox, SandboxNotFoundError } from "e2b";

/** E2B kills a sandbox this long after its last extension; one hour is the most every plan allows. */
const SANDBOX_TIMEOUT_MS = 60 * 60 * 1000;

export type E2bSandbox = {
  readonly sandboxId: string;
  readonly metadata: Readonly<Record<string, string>>;
};

export type E2bCommand = {
  readonly cmd: string;
  readonly cwd: string;
  readonly envs: Readonly<Record<string, string>>;
};

/** The part of E2B the provisioner uses. */
export type E2bApi = {
  list(metadata: Readonly<Record<string, string>>): Promise<readonly E2bSandbox[]>;
  /** Creates a sandbox from the template, starts `command` in it and leaves it running; resolves with the sandbox id. */
  create(metadata: Readonly<Record<string, string>>, command: E2bCommand): Promise<string>;
  /** Restarts the sandbox's timeout; one already gone is left so. */
  extend(sandboxId: string): Promise<void>;
  /** Kills the sandbox; one already gone counts as killed. */
  kill(sandboxId: string): Promise<void>;
  /** Read by id, which unlike the listing is current at once. */
  exists(sandboxId: string): Promise<boolean>;
};

type ConnectE2bOpts = {
  readonly apiKey: string;
  /** The template's name or id. */
  readonly template: string;
};

export function connectE2b({ apiKey, template }: ConnectE2bOpts): E2bApi {
  async function unlessGone(operation: Promise<unknown>): Promise<void> {
    try {
      await operation;
    } catch (error) {
      if (!(error instanceof SandboxNotFoundError)) throw error;
    }
  }

  async function kill(sandboxId: string): Promise<void> {
    await unlessGone(Sandbox.kill(sandboxId, { apiKey }));
  }

  return {
    async list(metadata) {
      // E2B refuses an empty metadata filter.
      const filter = Object.keys(metadata).length > 0 ? { metadata: { ...metadata } } : {};
      const paginator = Sandbox.list({ apiKey, query: { ...filter, state: ["running", "paused"] } });
      const sandboxes: E2bSandbox[] = [];
      while (paginator.hasNext) sandboxes.push(...(await paginator.nextItems()));
      return sandboxes;
    },
    async create(metadata, { cmd, cwd, envs }) {
      const sandbox = await Sandbox.create(template, {
        apiKey,
        timeoutMs: SANDBOX_TIMEOUT_MS,
        lifecycle: { onTimeout: "kill", autoResume: false },
        allowInternetAccess: true,
        metadata: { ...metadata },
      });
      try {
        // E2B ends a command at its timeout, 60 seconds unless 0; the sandbox timeout bounds the sidecar instead.
        const handle = await sandbox.commands.run(cmd, { background: true, cwd, envs: { ...envs }, timeoutMs: 0 });
        await handle.disconnect();
      } catch (error) {
        await kill(sandbox.sandboxId);
        throw error;
      }
      return sandbox.sandboxId;
    },
    async extend(sandboxId) {
      await unlessGone(Sandbox.setTimeout(sandboxId, SANDBOX_TIMEOUT_MS, { apiKey }));
    },
    kill,
    async exists(sandboxId) {
      try {
        await Sandbox.getInfo(sandboxId, { apiKey });
        return true;
      } catch (error) {
        if (error instanceof SandboxNotFoundError) return false;
        throw error;
      }
    },
  };
}
