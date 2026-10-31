// Triage's real listener and manager definitions, each run through Interchange's runLocal in this process, against the
// hub's own intake and manager routes on a database of their own and the chain's fake GitHub, which records every
// write. Steps authorize against the grants a deployed run holds, built by Interchange's local credentials snapshot
// from the definition and the grants recorded for the run. Mail between runs waits in one queue the test drains, so
// the order runs see events in is the test's to choose.
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { type } from "arktype";
import { createWorkflowDirectorRegistry } from "@intx/agent";
import { actionConsumer, authorize, toolConsumer } from "@intx/authz";
import { createNoopCredentialCipher } from "@intx/crypto";
import { createDB, createGrantStore, createRunTokenStore, runMigrations, schema } from "@intx/db";
import { buildCredentialCapabilities, createActionCredentialsFactory, createCredentialProviderRegistry, createHttpCredentialProvider, createInferenceCredentialResolver } from "@intx/harness";
import { createApp, createRequireGrant, HUB_CONDITION_REGISTRY } from "@intx/hub-api";
import { createEventCollectorRegistry, createSidecarRouter, type SessionService } from "@intx/hub-sessions";
import { createDependencies } from "@intx/inference";
import { loadAdapterRegistry } from "@intx/inference/providers";
import { createIsogitStore } from "@intx/storage-isogit/node";
import { SELF_RUN_RESOURCE } from "@intx/types";
import { HUB_CREDENTIAL_HANDLE, hubCredentialId, type CredentialDelivery } from "@intx/types/credential-delivery";
import { createRuntimeCapabilities } from "@intx/types/runtime-capabilities";
import { WorkflowProjectionDefinition } from "@intx/types/sidecar";
import { projectLiveToInert, runLocal, type ActionHandler, type LoopFn, type OnTriggerPrimitive, type StepInvokeRequest, type WorkflowDefinition } from "@intx/workflow";
import { collectHubConsumers } from "@intx/workflow-deploy";
import { createCredentialsBackedAuthorize, createGrantEvaluator, createLocalCredentialsSnapshot, createWorkflowStepInvoker, snapshotStepGrants } from "@intx/workflow-host/local";
import { DEFAULT_REPO_POLICY, TRIAGE_LISTENERS, TRIAGE_MAIL_SENDER, TRIAGE_MANAGERS, type ActionKind, type CheckPack, type TriageEvent } from "@corbits/triage-contracts";
import * as actions from "@corbits/triage-manager/actions/index";
import { mailDirector } from "@corbits/triage-manager/directors";
import * as loops from "@corbits/triage-manager/loops";
import type { Release } from "@corbits/triage-manager/release";
import { triageListener } from "@corbits/triage-manager/triage-listener";
import { PASSES, triageManager } from "@corbits/triage-manager/triage-manager";
import { mailPayload } from "../../apps/hub/src/github/bridge.ts";
import { RunUnavailableError } from "../../apps/hub/src/github/deployment.ts";
import { createManagerIntake, createManagerWake, createSupersede } from "../../apps/hub/src/manager-intake.ts";
import { MANAGER_RUN_TOKEN_ROUTES } from "../../apps/hub/src/manager-routes.ts";
import type { PullRequestRef } from "../../apps/hub/src/manager-state.ts";
import { mountTenantRoutes } from "../../apps/hub/src/tenant-routes.ts";
import { migrateTriageTables } from "../../apps/hub/src/triage-db.ts";
import { fakeGithub, type Pull, type Write } from "../chain/github.ts";

const ADMIN_DB = { host: "localhost", port: 5432, user: "postgres", password: "postgres", database: "interchange" };
const TENANT = "tnt_model";
const DOMAIN = "model.test";
const HUB_ORIGIN = "https://hub.test";
const GITHUB_ORIGIN = "https://api.github.com";
const APP_LOGIN = "corbits[bot]";
const OWNER_PRINCIPAL = "prn_owner";
const LISTENER_RUN = "run_listener";
const REVIEWER = "pr-code-review-reviewer-github";
const OFFERINGS = { ids: ["off_model"], defaultId: "off_model" };

/** The manager the release publishes beside the listener, as the hub writes it into `release.json`. */
export const MANAGER_RELEASE: Release = {
  workflow: { assetId: `ast_${TRIAGE_MANAGERS.github}`, commitSha: "c0ffee", packageName: "@corbits/triage-manager", entry: "./triage-manager-github.mjs" },
  offerings: OFFERINGS,
};

/** The code review the release publishes beside the manager; its run never reports, as `ReviewFault` plays. */
export const REVIEW_RELEASE: Release = {
  name: "pr-code-review-reviewer-github",
  workflow: { assetId: `ast_${REVIEWER}`, commitSha: "c0ffee", packageName: "@corbits/pr-code-review-reviewer-github-workflow", entry: "./pr-code-review-reviewer-github.mjs" },
  offerings: OFFERINGS,
};

/** The definitions as the published `triage-listener-github` and `triage-manager-github` entries build them from that release. */
const listenerDefinition = triageListener({ id: TRIAGE_LISTENERS.github, manager: MANAGER_RELEASE });
const managerDefinition = triageManager({ id: TRIAGE_MANAGERS.github, sources: ["github"], codeReview: REVIEW_RELEASE });

/** Each published release by its asset, and the definition it deploys; code review's never runs. */
const RELEASED = new Map<string, { release: Release; definition?: WorkflowDefinition }>([
  [MANAGER_RELEASE.workflow.assetId, { release: MANAGER_RELEASE, definition: managerDefinition }],
  [REVIEW_RELEASE.workflow.assetId, { release: REVIEW_RELEASE }],
]);

const DeployBody = type({
  source: { kind: "'asset'", assetId: "string", package: { format: "'source'", commitSha: "string", packageName: "string" } },
  entry: "string",
  sourceOfferingIds: "string[]",
  defaultSourceOfferingId: "string",
});
const MailText = type({ "prNumber?": "number", "items?": type({ prNumber: "number" }).array() });

type Db = ReturnType<typeof createDB>["db"];
type Run = { definition: WorkflowDefinition; principalId: string; tokens: ReadonlyMap<string, string> };

const sessionService: SessionService = {
  stageWorkflowStep() {
    throw new Error("no session runs here");
  },
  endSession() {
    throw new Error("no session runs here");
  },
};

/** A mail as stock hands it to the run it is addressed to. */
function stockMail(from: string, to: string, text: string) {
  return { headers: { from, to: [to] }, rawHeaders: {}, parts: [{ contentType: "text/plain", ref: "part-0", text }] };
}

/** A mail waiting for its run; a copy the test delivers a second time keeps its `id`. */
export type Mail = { id: string; to: string; payload: ReturnType<typeof stockMail> };

/** The consumers of the hub credential, each of which gets a run token, as deploy reads them off the definition's projection. */
function hubConsumers(definition: WorkflowDefinition): readonly string[] {
  return collectHubConsumers(WorkflowProjectionDefinition.assert(projectLiveToInert(definition)));
}

function tokenOf(tokens: ReadonlyMap<string, string>, consumer: string): string {
  const token = tokens.get(consumer);
  if (token === undefined) throw new Error(`no run token was minted for ${consumer}`);
  return token;
}

/** The pull requests a mail names: a manager's mail names one, the hub's mail to the listener one or more. */
function pullsOfMail(mail: Mail): number[] {
  const named = MailText(JSON.parse(mail.payload.parts[0]!.text));
  if (named instanceof type.errors) throw new Error(`mail to ${mail.to}: ${named.summary}`);
  return named.items?.map((item) => item.prNumber) ?? (named.prNumber === undefined ? [] : [named.prNumber]);
}

/** A database of the hub's own schema with one tenant whose `repo` is connected, and the two triage definitions. */
async function createDatabase(repo: string) {
  const name = `corbits_model_${randomBytes(6).toString("hex")}`;
  const admin = createDB(ADMIN_DB);
  try {
    await admin.db.execute(sql.raw(`create database ${name}`));
  } finally {
    await admin.close();
  }
  const config = { ...ADMIN_DB, database: name };
  await runMigrations(config, { schema: "public" });
  const handle = createDB(config);
  await migrateTriageTables(handle.db, "public");
  await handle.db.insert(schema.tenant).values({ id: TENANT, name: "Model", slug: "model", domain: DOMAIN, config: { corbitsTriage: { repos: [{ name: repo, connected: true, enabled: true }] } } });
  await handle.db.insert(schema.principal).values({ id: OWNER_PRINCIPAL, tenantId: TENANT, kind: "user", refId: "usr_owner", status: "active" });
  for (const workflow of [TRIAGE_LISTENERS.github, TRIAGE_MANAGERS.github, REVIEWER]) {
    await handle.db.insert(schema.asset).values({ id: `ast_${workflow}`, tenantId: TENANT, kind: "workflow", name: workflow, creatorPrincipalId: OWNER_PRINCIPAL });
    await handle.db.insert(schema.workflowDefinition).values({ id: `wfd_${workflow}`, tenantId: TENANT, name: workflow, assetId: `ast_${workflow}` });
  }
  async function drop(): Promise<void> {
    await handle.close();
    const again = createDB(ADMIN_DB);
    try {
      await again.db.execute(sql.raw(`drop database if exists ${name} with (force)`));
    } finally {
      await again.close();
    }
  }
  return { db: handle.db, drop };
}

async function noSession() {
  return null;
}

function noAuthRoute(): Response {
  return new Response(null, { status: 404 });
}

/** The hub's stock app with its run-token routes and the hub's manager routes mounted, as the hub serves them. */
function hubApp(db: Db, wake: ReturnType<typeof createManagerWake>, supersede: (tenantId: string, pr: PullRequestRef) => Promise<void>, log: (entry: Record<string, unknown>) => void) {
  const app = createApp({
    getSession: noSession,
    authHandler: noAuthRoute,
    db,
    sidecarRouter: createSidecarRouter({
      async withExecutableWorkflowRun(_target, send) {
        return send();
      },
      async authenticateSidecar({ sidecarId }) {
        return { sidecarId };
      },
      async resolveSidecarBindings() {
        return [];
      },
      async validateSidecarIdentity() {
        return true;
      },
    }),
    sessionService,
    eventCollectors: createEventCollectorRegistry({ db }),
    assetService: null,
    repoStore: null,
    maxTarballBytes: 10_000_000,
    credentialCipher: createNoopCredentialCipher(),
    extraRunTokenRoutes: MANAGER_RUN_TOKEN_ROUTES,
  });
  mountTenantRoutes(app, { db, requireGrant: createRequireGrant({ grantStore: createGrantStore(db), conditionRegistry: HUB_CONDITION_REGISTRY }), log, wake, supersede, taken: noteTaken });
  return app;
}

function noteTaken(): void {}

/** The hub's log lines; the rules read what GitHub and the hub hold, never what was logged. */
function log(): void {}

/**
 * How a code review run ends without reporting: its sandbox never connects, so it fails before it is ready; or it is
 * ready and takes its mail, then its sandbox dies.
 */
type ReviewFault = "fails-before-ready" | "dies-after-mail";

/**
 * A repository with `pack` as its policy, with code review on when `review` names how its runs fail, `automatic` the
 * kinds the pr-triage role holds on it, and everything a run of it reaches; call `stop` after.
 */
export async function modelStack(repo: string, { pack, automatic, review }: { pack: CheckPack; automatic: ActionKind[]; review?: ReviewFault }) {
  const policyWorkflow = review && { "code-review": { on: true } };
  const github = fakeGithub();
  github.addRepo(repo, null);
  const { db, drop } = await createDatabase(repo);
  const grantStore = createGrantStore(db);
  const queue: Mail[] = [];
  const runs = new Map<string, Run>();
  /** Each manager run's pull request, read off the mail its listener was deploying it for; none when that mail named several. */
  const managed = new Map<string, number | undefined>();
  /** The pull request being played when each manager run was deployed: a manager attributed to none is reported for that one. */
  const deployedWhile = new Map<string, number>();
  let playing = 0;
  /** Mail dropped at a run that had ended, or refused when sent to one; one whose copy a run took is not lost. */
  const dropped: Mail[] = [];
  const delivered = new Set<string>();
  /** Each run whose body ended other than completed, or a step that threw. */
  const failed: { mail: Mail; status: string }[] = [];
  /** Each code review run's pull request, read off the mail its manager was running. */
  const reviews = new Map<string, number | undefined>();
  /** Code review runs read again after a read showed they had ended. */
  const waited: string[] = [];
  /** Code review runs a read showed ended. */
  const seen = new Set<string>();
  /** Each code review run that died after taking its mail, and how many times its manager took its pull request since. */
  const died = new Map<string, number>();
  /** How many times each manager run took each pull request on each of its heads. */
  const takes = new Map<string, { pull: number; count: number }>();
  /** Each mail whose manager ran out of passes. */
  const exhausted: Mail[] = [];
  let clockReads = 0;

  /**
   * Stock's clock for a local run, an hour further ahead on each read, so every timer a run sets, as the manager's poll,
   * is already due when it is scheduled. Actions read the real clock.
   */
  function timersAtOnce(): Date {
    clockReads += 1;
    return new Date(Date.now() + clockReads * TIMER_SKIP_MS);
  }
  const directors = createWorkflowDirectorRegistry([mailDirector.factory]);
  const adapters = await loadAdapterRegistry([], { import: async function noAdapters() { return {}; } });
  const runTokens = createRunTokenStore({ db, cipher: createNoopCredentialCipher() });

  /**
   * Stock's deploy: a run of `definition` with its own principal, the grants its definition requires of its creator,
   * the self-run requirement bound to the run, and a run token for each consumer of the hub credential.
   */
  async function deployRun(runId: string, definition: WorkflowDefinition): Promise<void> {
    const principalId = `prn_${runId}`;
    await db.insert(schema.principal).values({ id: principalId, tenantId: TENANT, kind: "workflow", refId: runId, status: "active" });
    await db.insert(schema.workflowRun).values({ id: runId, anchorRunId: runId, definitionId: `wfd_${definition.id}`, tenantId: TENANT, principalId, status: "deployed" });
    for (const requirement of definition.grantRequirements ?? []) {
      const resource = requirement.resource === SELF_RUN_RESOURCE ? `workflow-run:${runId}` : requirement.resource;
      await db.insert(schema.grant).values({ id: randomUUID(), tenantId: TENANT, principalId, resource, action: requirement.action, effect: "allow", origin: "creator" });
    }
    await runTokens.mintIfAbsent({ principalId, consumers: [...hubConsumers(definition)] }, db);
    const delivery = await runTokens.loadDelivery(principalId);
    runs.set(runId, { definition, principalId, tokens: new Map(delivery.map((row) => [row.consumer, row.token])) });
  }

  async function live(runId: string): Promise<boolean> {
    const [run] = await db.select({ status: schema.workflowRun.status }).from(schema.workflowRun).where(eq(schema.workflowRun.id, runId));
    return run !== undefined && schema.isLiveWorkflowRunStatus(run.status);
  }

  async function endRun(runId: string): Promise<void> {
    await db.update(schema.workflowRun).set({ status: "cancelled" }).where(eq(schema.workflowRun.id, runId));
  }

  async function granted(runId: string, resource: string, action: string): Promise<boolean> {
    const run = runs.get(runId);
    if (!run) return false;
    return (await authorize(grantStore, run.principalId, TENANT, resource, action, { conditions: HUB_CONDITION_REGISTRY })).effect === "allow";
  }

  async function cancelForHub(_tenantId: string, runId: string): Promise<void> {
    await endRun(runId);
  }

  const { supersede } = createSupersede({ db, cancel: cancelForHub, log });

  /** The hub's mail to a run, as `deliverToListener` sends it: a run that is not live takes none. */
  async function deliver(_tenantId: string, address: string, payload: unknown): Promise<void> {
    if (!(await live(address.slice(0, address.indexOf("@"))))) throw new RunUnavailableError(`${address} is not a live deployment`);
    queue.push({ id: randomUUID(), to: address, payload: stockMail(`${TRIAGE_MAIL_SENDER}@${DOMAIN}`, address, JSON.stringify(payload)) });
  }

  async function listener(): Promise<string> {
    return `${LISTENER_RUN}@${DOMAIN}`;
  }

  async function routable(): Promise<boolean> {
    return true;
  }

  async function withAppLogin(_tenantId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    return { ...payload, appLogin: APP_LOGIN };
  }

  async function ungated(_tenantId: string, _record: unknown, _number: number, request: Record<string, unknown>): Promise<Record<string, unknown>> {
    return request;
  }

  const wake = createManagerWake({ db, listener, deliver });
  const app = hubApp(db, wake, supersede, log);
  const toListener = createManagerIntake({
    db,
    listener,
    routable,
    async readPull(_tenantId, _record, number) {
      const pull = github.pull(repo, number);
      return { title: pull.title, description: pull.body, headSha: pull.head, draft: pull.draft === true, open: true, diff: "" };
    },
    openHeads: function openHeads() {
      throw new Error("no backlog in this stack");
    },
    withAppLogin,
    gate: ungated,
    deliver,
    supersede,
    log,
  });

  /** Stock's deploy route: the caller must hold the deploy and the asset's read, and the body must name a published release exactly. */
  async function deployRoute(runId: string, serving: readonly number[], init?: RequestInit): Promise<Response> {
    const body = DeployBody(JSON.parse(String(init?.body)));
    if (body instanceof type.errors) return Response.json({ error: { code: "invalid_request", message: body.summary } }, { status: 400 });
    const { assetId, package: pkg } = body.source;
    if (!(await granted(runId, "workflow:*", "create")) || !(await granted(runId, `asset:${assetId}`, "read"))) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    const released = RELEASED.get(assetId);
    const { workflow } = released?.release ?? {};
    if (!released || workflow?.packageName !== pkg.packageName || workflow.commitSha !== pkg.commitSha || workflow.entry !== body.entry) {
      return Response.json({ error: { code: "not_found", message: `${assetId} publishes no ${pkg.packageName}@${pkg.commitSha} ${body.entry}` } }, { status: 404 });
    }
    const id = `run_${randomBytes(6).toString("hex")}`;
    if (!released.definition) return reviewRoute(id, runId, serving);
    await deployRun(id, released.definition);
    managed.set(id, serving.length === 1 ? serving[0] : undefined);
    deployedWhile.set(id, playing);
    return Response.json({ id }, { status: 201 });
  }

  /**
   * Code review's deploy: stock records the run, failed at once when its sandbox never connects, or else ready, and
   * grants its deployer `manage` on it.
   */
  async function reviewRoute(id: string, deployer: string, serving: readonly number[]): Promise<Response> {
    const principalId = `prn_${id}`;
    const state = review === "fails-before-ready" ? { status: "failed" as const } : { status: "running" as const, publicKey: "model-key" };
    await db.insert(schema.principal).values({ id: principalId, tenantId: TENANT, kind: "workflow", refId: id, status: "active" });
    await db.insert(schema.workflowRun).values({ id, anchorRunId: id, definitionId: `wfd_${REVIEWER}`, tenantId: TENANT, principalId, address: `${id}@${DOMAIN}`, ...state });
    await db.insert(schema.grant).values({ id: randomUUID(), tenantId: TENANT, principalId: `prn_${deployer}`, resource: `workflow-run:${id}`, action: "manage", effect: "allow", origin: "creator" });
    reviews.set(id, serving.length === 1 ? serving[0] : undefined);
    return Response.json({ id }, { status: 201 });
  }

  /**
   * Stock's run read. A code review run read again after a read showed it ended is recorded and refused, so a manager
   * that keeps waiting on it fails its mail at once rather than after the review's deadline.
   */
  async function readRoute(target: string, url: URL, init?: RequestInit): Promise<Response> {
    if (!reviews.has(target) || (await live(target))) return app.request(url, init);
    if (seen.has(target)) {
      waited.push(target);
      return Response.json({ error: { code: "model_waited_on_ended_run" } }, { status: 500 });
    }
    seen.add(target);
    return app.request(url, init);
  }

  /**
   * The hub's take. A manager that takes its pull request a second time after its code review run died, with no read
   * showing the run ended, is waiting for a report that cannot come: it is recorded and refused, so the manager ends
   * rather than polling until the review's deadline.
   */
  async function takeRoute(runId: string, serving: readonly number[], url: URL, init?: RequestInit): Promise<Response> {
    for (const pull of serving) {
      const key = `${runId} ${github.pull(repo, pull).head}`;
      takes.set(key, { pull, count: (takes.get(key)?.count ?? 0) + 1 });
    }
    for (const [id, since] of died) {
      const pull = reviews.get(id);
      if (seen.has(id) || pull === undefined || !serving.includes(pull)) continue;
      died.set(id, since + 1);
      if (since === 0) continue;
      waited.push(id);
      return Response.json({ error: { code: "model_waited_on_ended_run" } }, { status: 409 });
    }
    return app.request(url, init);
  }

  /** Stock's stop-run route: the caller must hold `manage` on the run; stock then ends it, here at once. */
  async function stopRoute(runId: string, target: string): Promise<Response> {
    if (!(await granted(runId, `workflow-run:${target}`, "manage"))) return Response.json({ error: { code: "forbidden" } }, { status: 403 });
    if (!(await live(target))) return Response.json({ error: { code: "workflow_run_terminal" } }, { status: 409 });
    await endRun(target);
    return new Response(null, { status: 202 });
  }

  /**
   * The hub as `runId` reaches it while it runs mail naming `serving`: stock's deploy and stop-run routes stand in here,
   * the rest is the hub's own app.
   */
  async function hubFetch(runId: string, serving: readonly number[], url: URL, init?: RequestInit): Promise<Response> {
    const method = init?.method ?? "GET";
    const runPath = /^\/api\/tenants\/[^/]+\/workflows\/runs\/([^/]+)$/.exec(url.pathname);
    if (method === "POST" && url.pathname === `/api/tenants/${TENANT}/workflows/deployments`) return deployRoute(runId, serving, init);
    if (method === "DELETE" && runPath) return stopRoute(runId, decodeURIComponent(runPath[1]!));
    if (method === "GET" && runPath) return readRoute(decodeURIComponent(runPath[1]!), url, init);
    if (url.pathname === `/api/tenants/${TENANT}/manager/take`) return takeRoute(runId, serving, url, init);
    return app.request(url, init);
  }

  /** What the hub delivers `runId`: GitHub for its definition's bindings, and each consumer of the hub credential its own run token. */
  function deliveryOf({ definition, tokens }: Run): CredentialDelivery {
    const bindings = (definition.credentialBindings ?? []) as readonly ({ handle: string; package: string } | { handle: string; action: string })[];
    const hub = hubConsumers(definition);
    return {
      bindings: [
        ...bindings.map((binding) => ({ handle: binding.handle, credentialId: "github", consumer: "package" in binding ? toolConsumer(binding.package) : actionConsumer(binding.action) })),
        ...hub.map((consumer) => ({ handle: HUB_CREDENTIAL_HANDLE, credentialId: hubCredentialId(consumer), consumer })),
      ],
      materials: [
        { credentialId: "github", providerKey: "http", origin: GITHUB_ORIGIN, secret: "installation-token" },
        ...hub.map((consumer) => ({ credentialId: hubCredentialId(consumer), providerKey: "http", origin: HUB_ORIGIN, secret: tokenOf(tokens, consumer) })),
      ],
    };
  }

  /** Runs one mail's body of the run it is addressed to to its end, as the run's sidecar would; stock drops mail to a run that ended. */
  async function runMail(mail: Mail): Promise<void> {
    const runId = mail.to.slice(0, mail.to.indexOf("@"));
    const run = runs.get(runId);
    if (!run) throw new Error(`mail to ${mail.to}, which is no run`);
    if (!(await live(runId))) {
      dropped.push(mail);
      return;
    }
    delivered.add(mail.id);
    await db.update(schema.workflowRun).set({ status: "running" }).where(and(eq(schema.workflowRun.id, runId), eq(schema.workflowRun.status, "deployed")));
    const serving = pullsOfMail(mail);
    const cell = { current: deliveryOf(run) };
    const requirements = await grantStore.collectGrants(run.principalId, TENANT);
    const snapshot = { current: createLocalCredentialsSnapshot({ definition: run.definition, directors, delivery: cell.current, grants: requirements }) };
    const workflowAuthorize = createCredentialsBackedAuthorize(snapshot, createGrantEvaluator({ floorFor: noFloor }));
    async function routed(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin === HUB_ORIGIN) return hubFetch(runId, serving, url, init);
      return fetch(`${github.origin}${url.pathname}${url.search}`, init);
    }
    const providers = createCredentialProviderRegistry([createHttpCredentialProvider({ fetch: routed })]);
    const address = `${runId}@${DOMAIN}`;
    const root = mkdtempSync(join(tmpdir(), "corbits-model-"));

    /**
     * Stock's transport: mail to a run that is not live is refused, and lost to the run that sent it. A code review run
     * takes its mail and dies, as stock records a run whose sandbox was lost.
     */
    async function send(message: { to: string; content: string }) {
      const to = message.to.slice(0, message.to.indexOf("@"));
      const sent = { id: randomUUID(), to: message.to, payload: stockMail(address, message.to, message.content) };
      if (!(await live(to))) {
        dropped.push(sent);
        throw new Error(`${message.to} is not a live run`);
      }
      if (reviews.has(to)) {
        await db.update(schema.workflowRun).set({ status: "failed" }).where(eq(schema.workflowRun.id, to));
        died.set(to, 0);
        return { messageId: randomUUID(), status: "queued" };
      }
      queue.push(sent);
      return { messageId: randomUUID(), status: "queued" };
    }

    /** What the sidecar gives the mail agent's step: its run's address, the mail transport and the credentials its grants allow. */
    async function buildEnv(req: StepInvokeRequest) {
      const workdir = mkdtempSync(join(root, "step-"));
      const storage = await createIsogitStore(workdir);
      const toolCwd = join(workdir, "workspace");
      mkdirSync(toolCwd);
      const factories = req.agent.toolFactories.map((factory) => ({ packageName: factory.id, declaredCredentials: [], factory }));
      const stepGrants = snapshotStepGrants(snapshot, req.authzContext.stepId!);
      const [credentials] = buildCredentialCapabilities(factories, { materialCell: cell, resolveGrants: function stepGrantsOf() { return stepGrants; }, providers }).values();
      const source = { id: "unused", provider: "unused", baseURL: "http://127.0.0.1:9", credentialId: "unused", model: "unused" };
      return {
        sources: [source],
        defaultSource: source.id,
        storage,
        audit: storage,
        workdir,
        toolCwd,
        directors,
        deps: createDependencies(adapters),
        readCurrentMaterial: createInferenceCredentialResolver(cell),
        capabilities: createRuntimeCapabilities(credentials ? { credentials } : {}),
        address,
        transport: { send },
      };
    }

    function resolveAction(ref: string): ActionHandler {
      return (actions as Record<string, ActionHandler>)[ref]!;
    }

    function resolveLoop(ref: string): LoopFn {
      return (loops as Record<string, LoopFn>)[ref]!;
    }

    function actionGrants({ stepId }: { stepId: string }) {
      return snapshotStepGrants(snapshot, stepId);
    }

    const body = (run.definition.steps["events"] as OnTriggerPrimitive).body;
    if (!("inline" in body)) throw new Error(`${run.definition.id}'s body is not inline`);
    try {
      const { terminalStatus, outputs } = await runLocal(body.inline, {
        authorize: workflowAuthorize,
        directors,
        hasUpstreamSignalResolver: true,
        invokeStep: createWorkflowStepInvoker({ workflowAuthorize, buildEnv }),
        actionResolver: resolveAction,
        actionCredentials: createActionCredentialsFactory({ materialCell: cell, resolveStepGrants: actionGrants, providers }),
        loopFns: resolveLoop,
        triggerPayload: mail.payload,
        ...(review === "dies-after-mail" && { clock: timersAtOnce }),
      }).complete;
      if (terminalStatus !== "completed") failed.push({ mail, status: terminalStatus });
      // The listener's body has no passes.
      const passes = Passes(outputs["passes"]);
      if (!(passes instanceof type.errors) && passes.iterations >= PASSES) exhausted.push(mail);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  await deployRun(LISTENER_RUN, listenerDefinition);
  await db.update(schema.workflowRun).set({ status: "running" }).where(eq(schema.workflowRun.id, LISTENER_RUN));

  /** The hub takes in a webhook on pull request `number` as the bridge mails it once its window flushes: `event` on `head`. */
  async function webhook(number: number, event: TriageEvent, head: string): Promise<void> {
    const request = mailPayload({ name: repo }, { ...DEFAULT_REPO_POLICY, enabled: true }, { pack, automatic, policyWorkflow, source: { file: { path: ".corbits-triage.yml", sha: "model-1" } } }, { tenantId: TENANT, prNumber: number, headSha: head, deliveryId: randomUUID(), events: [event] });
    if (!(await toListener(TENANT, request))) throw new Error(`the hub took no mail for ${repo}#${number}`);
  }

  function ofPull(number: number) {
    return function named(mail: Mail): boolean {
      return pullsOfMail(mail).includes(number);
    };
  }

  return {
    github,
    repo,
    queue,
    webhook,
    /** GitHub shows `pull` with no checks yet, and the hub takes in its opened webhook. */
    async open(pull: Pull): Promise<void> {
      github.open(repo, pull);
      playing = pull.number;
      await webhook(pull.number, "opened", pull.head);
    },
    /** Runs the queued mail at `index` to its end, as the run it is addressed to. */
    async run(index: number): Promise<void> {
      const [mail] = queue.splice(index, 1);
      if (!mail) throw new Error(`no mail is queued at ${index}`);
      await runMail(mail);
    },
    /** Delivers the queued mail at `index` a second time. */
    duplicate(index: number): void {
      const mail = queue[index];
      if (!mail) throw new Error(`no mail is queued at ${index}`);
      queue.push(mail);
    },
    /** Runs each queued mail in turn, oldest first, until none is left. */
    async drain(): Promise<void> {
      for (let mail = queue.shift(); mail; mail = queue.shift()) await runMail(mail);
    },
    /**
     * What is left of pull request `number`'s runs and mail: its managers still live, live managers deployed while it was
     * played that no pull request can be told for, mail no run took, runs that did not complete, its code review runs
     * waited on after they had ended, managers that ran out of passes, and the most times one manager took it on one head.
     */
    async leftover(number: number) {
      const rows = await db.select({ id: schema.workflowRun.id, status: schema.workflowRun.status }).from(schema.workflowRun).where(eq(schema.workflowRun.definitionId, `wfd_${TRIAGE_MANAGERS.github}`));
      const running = rows.filter((row) => schema.isLiveWorkflowRunStatus(row.status)).map((row) => row.id);
      const named = ofPull(number);
      const failures = failed.filter((failure) => named(failure.mail)).map((failure) => `${failure.mail.to} ${failure.status}`);
      const lost = dropped.filter((mail) => named(mail) && !delivered.has(mail.id));
      const unattributed = running.filter((id) => managed.get(id) === undefined && deployedWhile.get(id) === number);
      return { live: running.filter((id) => managed.get(id) === number), unattributed, lost, failed: failures, waited: waited.filter((id) => reviews.get(id) === number), exhausted: exhausted.filter(named).map((mail) => mail.to), mostTakes: Math.max(0, ...[...takes.values()].filter((taken) => taken.pull === number).map((taken) => taken.count)) };
    },
    /** The code review runs deployed for pull request `number`. */
    reviewRuns(number: number): string[] {
      return [...reviews].filter(([, pull]) => pull === number).map(([id]) => id);
    },
    /** The code review runs a manager read as ended, so a check of them can tell it played some. */
    reviewsRead(): string[] {
      return [...seen];
    },
    /** The writes to pull request `number` and to its comments, in the order GitHub received them. */
    writes(number: number): Write[] {
      const own = new Set(github.writesTo(repo, number));
      const comments = new Set(github.pull(repo, number).comments.map((comment) => `/repos/${repo}/issues/comments/${comment.id}`));
      return github.writes.filter((write) => own.has(write) || comments.has(write.path));
    },
    async stop(): Promise<void> {
      github.stop();
      await drop();
    },
  };
}

/** An hour, longer than any timer a run sets. */
const TIMER_SKIP_MS = 60 * 60_000;

/** A manager run's loop of passes, as runLocal outputs it. */
const Passes = type({ iterations: "number" });

function noFloor() {
  return [];
}
