import { expect, test } from "bun:test";
import { checkPackName, emptyPack } from "@corbits/triage-contracts";

/** One rule on; with every rule off the hub starts no run. */
const PACK = { ...emptyPack("octocat/hello"), checks: { "no-merge-conflicts": { enabled: true } } };
import { createBacklogStart, createGithubBacklog } from "./backlog-triage.js";
import { NoLiveDeploymentError } from "./deployment.js";
import { DEFAULT_RECONCILE_POLICY } from "./reconcile-plan.js";

/** A listener takes every backlog here, so no head is held. */
const NOT_HELD = {
  async openHeads(): Promise<never> {
    throw new Error("no head is held");
  },
  store: {
    async load(): Promise<never> {
      throw new Error("no head is held");
    },
    async save(): Promise<never> {
      throw new Error("no head is held");
    },
  },
  policy: DEFAULT_RECONCILE_POLICY,
  now: () => new Date(),
  retry() {},
};

/** No deployment holds the credential in these tests. */
async function noKeyPush(): Promise<void> {}

const REPO = "acme/widgets";
const MEMBER = { tenantId: "tenant-1", principalId: "member-1" };
const SOURCE = { file: { path: ".corbits-triage.yml", sha: "art_pack-2" } };

function backlog(repo: Record<string, unknown>, sent: unknown[], sendMail = async function send(_tenant: string, payload: unknown) {
  sent.push(payload);
}) {
  return createGithubBacklog({
    db: {
      query: {
        credential: { async findFirst() { return { id: "crd_github", secret: "sealed", status: "active", principalId: null }; } },
        tenant: { async findFirst() { return { domain: "tenant.example", config: { corbitsTriage: { repos: [repo] } } }; } },
      },
    } as never,
    cipher: { async decrypt() { return "{}"; } } as never,
    onKeyMoved: noKeyPush,
    async authorize() {
      return true;
    },
    async readCheckPack() {
      return { status: "ok", pack: PACK, automatic: ["labels"], source: SOURCE };
    },
    sendMail,
    ...NOT_HELD,
    log() {},
  });
}

test("a backlog request mails the listener the bridge's payload as a backlog, and only for an enabled repository with a live listener", async () => {
  const sent: unknown[] = [];
  const started = await backlog({ name: REPO, connected: true, enabled: true }, sent)({ repo: REPO }, MEMBER);
  expect(started.status).toBe(202);
  expect(sent).toEqual([expect.objectContaining({ kind: "backlog", repo: REPO, pack: PACK, automatic: ["labels"], policy: expect.objectContaining({ checkPack: { name: checkPackName(REPO, "github") }, source: SOURCE }) })]);

  const disabled = await backlog({ name: REPO, connected: true, enabled: false }, sent)({ repo: REPO }, MEMBER);
  expect(await disabled.json()).toMatchObject({ error: { code: "repo_not_enabled" } });
  const notRunning = await backlog({ name: REPO, connected: true, enabled: true }, sent, async function noDeployment() {
    throw new NoLiveDeploymentError("triage-listener-github");
  })({ repo: REPO }, MEMBER);
  expect(notRunning.status).toBe(503);
  expect(sent).toHaveLength(1);
});

test("a Bitbucket Data Center repository's backlog goes to its listener like a GitHub one's", async () => {
  const sent: unknown[] = [];
  const start = createBacklogStart({
    async readCheckPack() {
      return { status: "ok", pack: PACK, automatic: ["labels"], source: SOURCE };
    },
    async sendMail(_tenant, payload) {
      sent.push(payload);
    },
    ...NOT_HELD,
    log() {},
  });
  const started = await start(MEMBER.tenantId, { name: "TRI/widgets", source: "bitbucket-datacenter", connected: true, enabled: true });
  expect(started.status).toBe(202);
  expect(sent).toEqual([expect.objectContaining({ kind: "backlog", repo: "TRI/widgets", repoSource: "bitbucket-datacenter" })]);
});
