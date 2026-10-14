import { expect, test } from "bun:test";
import { checkPackName, emptyPack } from "@corbits/triage-contracts";
import { createGithubBacklog } from "./backlog-triage.js";
import { NoLiveDeploymentError } from "./deployment.js";

const REPO = "acme/widgets";
const MEMBER = { tenantId: "tenant-1", principalId: "member-1" };
const SOURCE = { repo: { id: "art_pack", version: 2 } };

function backlog(repo: Record<string, unknown>, sent: unknown[], sendMail = async function send(_tenant: string, payload: unknown) {
  sent.push(payload);
}) {
  return createGithubBacklog({
    db: {
      query: {
        credential: { async findFirst() { return { id: "crd_github", secret: "sealed" }; } },
        tenant: { async findFirst() { return { domain: "tenant.example", config: { corbitsTriage: { repos: [repo] } } }; } },
      },
    } as never,
    cipher: { async decrypt() { return "{}"; } } as never,
    async authorize() {
      return true;
    },
    async readCheckPack() {
      return { status: "ok", pack: emptyPack(REPO), automatic: ["labels"], source: SOURCE };
    },
    sendMail,
    log() {},
  });
}

test("a backlog request mails pr-triage-historical the bridge's payload as a backlog, and only for an enabled repository with a live deployment", async () => {
  const sent: unknown[] = [];
  const started = await backlog({ name: REPO, connected: true, enabled: true }, sent)({ repo: REPO }, MEMBER);
  expect(started.status).toBe(202);
  expect(sent).toEqual([expect.objectContaining({ kind: "backlog", repo: REPO, pack: emptyPack(REPO), automatic: ["labels"], policy: expect.objectContaining({ checkPack: { name: checkPackName(REPO) }, source: SOURCE }) })]);

  const disabled = await backlog({ name: REPO, connected: true, enabled: false }, sent)({ repo: REPO }, MEMBER);
  expect(await disabled.json()).toMatchObject({ error: { code: "repo_not_enabled" } });
  const notRunning = await backlog({ name: REPO, connected: true, enabled: true }, sent, async function noDeployment() {
    throw new NoLiveDeploymentError("pr-triage-historical");
  })({ repo: REPO }, MEMBER);
  expect(notRunning.status).toBe(503);
  expect(sent).toHaveLength(1);
});
