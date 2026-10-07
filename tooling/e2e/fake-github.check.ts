// Self-check, not a test: starts the fake and requests each endpoint once.
//
//   bun tooling/e2e/fake-github.check.ts
import { startFakeGithub } from "./fake-github.js";

const fake = startFakeGithub({ port: 0 });
const headers = { authorization: "Bearer check", "content-type": "application/json" };
const repo = "/repos/acme/widgets";
const sha = `${"a".repeat(30)}0000000001`;

const requests: Array<[string, string, unknown?]> = [
  ["GET", "/app"],
  ["GET", "/app/installations"],
  ["POST", "/app/installations/100/access_tokens"],
  ["GET", "/installation/repositories"],
  ["GET", repo],
  ["GET", "/orgs/acme/members"],
  ["GET", `${repo}/pulls?state=open`],
  ["GET", `${repo}/pulls/1`],
  ["GET", `${repo}/pulls/1/reviews`],
  ["GET", `${repo}/pulls/1/commits`],
  ["GET", `${repo}/pulls/6/files`],
  ["GET", `${repo}/commits/${sha}/check-runs`],
  ["GET", `${repo}/issues/1/comments`],
  ["GET", `${repo}/issues/50`],
  ["POST", `${repo}/issues/1/comments`, { body: "hello" }],
  ["PUT", `${repo}/issues/1/labels`, { labels: ["triage"] }],
  ["POST", `${repo}/pulls/1/reviews`, { body: "ok", event: "COMMENT" }],
  ["PATCH", `${repo}/pulls/7`, { state: "closed" }],
];

async function getJson(path: string): Promise<unknown[]> {
  return (await fetch(fake.url + path, { headers })).json() as Promise<unknown[]>;
}

try {
  for (const [method, path, body] of requests) {
    const res = await fetch(fake.url + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
    console.log(res.ok ? "ok  " : "FAIL", res.status, method, path);
    if (!res.ok) process.exitCode = 1;
  }
  const files = await getJson(`${repo}/pulls/6/files?per_page=100`);
  const open = await getJson(`${repo}/pulls?state=open`);
  console.log(`open PRs ${open.length}, PR 6 files ${files.length}, calls ${fake.calls().length}, mirrored ${fake.mirrored().length}`);
  if (open.length !== 6 || files.length !== 35 || fake.mirrored().length !== 4) process.exitCode = 1;
} finally {
  fake.stop();
}
