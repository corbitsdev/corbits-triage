import { expect, test } from "bun:test";
import { bitbucketFetch, resolveInstance, type AddressLookup } from "./client.js";

const PUBLIC = "8.8.8.8";

// Every address the token must not reach, as a URL literal and as a DNS answer.
const REFUSED_ADDRESSES = [
  "127.0.0.1", "::1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "fc00::1",
  "0.0.0.0", "0.1.2.3", "::", "169.254.169.254", "fe80::1", "fd00:ec2::254",
  "100.64.0.1", "100.100.100.200", "192.0.0.192", "198.18.0.1", "224.0.0.1", "255.255.255.255",
  "64:ff9b::a9fe:a9fe", "2002:a9fe:a9fe::1", "::7f00:1", "::ffff:0:a00:5", "fec0::1", "::ffff:a9fe:a9fe", "::ffff:10.0.0.5",
];

function literal(address: string): string {
  return address.includes(":") ? `http://[${address}]` : `http://${address}`;
}

async function noLookup(): Promise<never> {
  throw new Error("a literal is not looked up");
}

async function instanceBaseUrl(value: string, allowlist: readonly string[] = []): Promise<string | undefined> {
  return (await resolveInstance(value, noLookup, allowlist))?.baseUrl;
}

function addresses(rows: readonly string[]): AddressLookup {
  return async function lookup() {
    return rows.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

test("an instance URL keeps its context path; refused shapes, metadata names and non-public literals are dropped", async () => {
  expect(await resolveInstance(" https://git.example/bitbucket/ ", addresses([PUBLIC]))).toEqual({ baseUrl: "https://git.example/bitbucket", address: PUBLIC });
  expect(await instanceBaseUrl(`http://${PUBLIC}:7990`)).toBe(`http://${PUBLIC}:7990`);
  expect(await instanceBaseUrl("http://[2606:4700::1111]")).toBe("http://[2606:4700::1111]");
  expect(await instanceBaseUrl("http://[::127.0.0.1]")).toBeUndefined();
  for (const refused of ["https://user:pw@git.example", "https://git.example/?a=1", "ftp://git.example", "http://metadata.google.internal", "http://metadata./"]) {
    expect(await instanceBaseUrl(refused)).toBeUndefined();
  }
  for (const address of REFUSED_ADDRESSES) expect(await instanceBaseUrl(literal(address))).toBeUndefined();
});

test("a name is pinned to an IPv4 answer first, and refused when the lookup fails, is empty, or any answer is not public", async () => {
  expect(await resolveInstance("https://git.example/bitbucket", addresses([PUBLIC]))).toEqual({ baseUrl: "https://git.example/bitbucket", address: PUBLIC });
  expect(await resolveInstance("https://git.example", addresses(["2606:4700::1111", PUBLIC]))).toEqual({ baseUrl: "https://git.example", address: PUBLIC });
  expect(await resolveInstance("https://git.example", async function fail() { throw new Error("servfail"); })).toBeUndefined();
  expect(await resolveInstance("https://git.example", addresses([]))).toBeUndefined();
  expect(await resolveInstance("https://git.example", addresses(["fe80::1%1"]))).toBeUndefined();
  for (const address of REFUSED_ADDRESSES) {
    expect(await resolveInstance("https://git.example", addresses([address]))).toBeUndefined();
    expect(await resolveInstance("https://git.example", addresses([PUBLIC, address]))).toBeUndefined();
  }
});

test("the allowlist unlocks a private or loopback host, nothing else", async () => {
  expect(await resolveInstance("http://Git.Internal:7990", addresses(["10.0.0.5"]), ["GIT.INTERNAL"])).toEqual({ baseUrl: "http://git.internal:7990", address: "10.0.0.5" });
  expect(await resolveInstance("http://git.internal", addresses(["fd12:3456::1"]), ["git.internal"])).toBeDefined();
  expect(await instanceBaseUrl("http://10.0.0.5:7990", ["10.0.0.5"])).toBe("http://10.0.0.5:7990");
  expect(await instanceBaseUrl("http://[::1]", ["::1"])).toBe("http://[::1]");
  for (const address of ["169.254.169.254", "fd00:ec2::254", "100.100.100.200", "192.0.0.192", "0.0.0.0", "fe80::1", "64:ff9b::a9fe:a9fe"]) {
    expect(await instanceBaseUrl(literal(address), [address])).toBeUndefined();
    expect(await resolveInstance("http://git.internal", addresses([address]), ["git.internal"])).toBeUndefined();
  }
  expect(await resolveInstance("http://metadata.google.internal", addresses([PUBLIC]), ["metadata.google.internal"])).toBeUndefined();
});

test("requests go to the address that was checked, with the name as Host and TLS server name, however DNS answers later", async () => {
  const answers = [PUBLIC, "169.254.169.254"];
  let lookups = 0;
  async function rebinding() {
    const address = answers[Math.min(lookups++, answers.length - 1)]!;
    return [{ address, family: 4 }];
  }
  const sent: Array<{ url: string; host: string | null; serverName: string | undefined }> = [];
  async function record(input: string | URL | Request, init?: RequestInit & { tls?: { serverName?: string } }): Promise<Response> {
    sent.push({ url: String(input), host: new Headers(init?.headers).get("host"), serverName: init?.tls?.serverName });
    return new Response("{}");
  }
  const checked = await resolveInstance("https://git.example:8443/bitbucket", rebinding);
  expect(checked).toBeDefined();
  const bb = bitbucketFetch(record as typeof fetch, checked!, "token");
  await bb("/rest/api/1.0/repos");
  await bb("/rest/api/1.0/projects");
  expect(lookups).toBe(1);
  expect(sent).toEqual([
    { url: `https://${PUBLIC}:8443/bitbucket/rest/api/1.0/repos`, host: "git.example:8443", serverName: "git.example" },
    { url: `https://${PUBLIC}:8443/bitbucket/rest/api/1.0/projects`, host: "git.example:8443", serverName: "git.example" },
  ]);
});
