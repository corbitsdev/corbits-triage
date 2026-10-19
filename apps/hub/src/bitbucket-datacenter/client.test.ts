import { expect, test } from "bun:test";
import { instanceBaseUrl, resolveInstanceBaseUrl, type AddressLookup } from "./client.js";

const REFUSED = [
  "https://user:pw@git.example",
  "https://git.example/?a=1",
  "ftp://git.example",
  "http://10.0.0.5:7990",
  "http://127.0.0.1",
  "http://[::1]",
  "http://10.1.2.3",
  "http://172.16.0.1",
  "http://192.168.1.1",
  "http://0.0.0.0",
  "http://[::]",
  "http://[fe80::1]",
  "http://[fc00::1]",
  "http://169.254.169.254/latest",
  "http://[fd00:ec2::254]",
  "http://[::ffff:a9fe:a9fe]",
  "http://[::ffff:10.0.0.5]",
  "http://metadata.google.internal",
  "http://metadata",
];

test("an instance URL keeps its context path; private, loopback, link-local, unspecified and metadata hosts are refused", () => {
  expect(instanceBaseUrl(" https://git.example/bitbucket/ ")).toBe("https://git.example/bitbucket");
  expect(instanceBaseUrl("http://203.0.113.10:7990")).toBe("http://203.0.113.10:7990");
  expect(instanceBaseUrl("http://0.0.0.1")).toBe("http://0.0.0.1");
  for (const refused of REFUSED) expect(instanceBaseUrl(refused)).toBeUndefined();
});

function addresses(rows: readonly string[]): AddressLookup {
  return async function lookup() {
    return rows.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  };
}

test("a name is refused when lookup fails or any address is loopback or private", async () => {
  expect(await resolveInstanceBaseUrl("https://git.internal/bitbucket", addresses(["127.0.0.1"]))).toBeUndefined();
  expect(await resolveInstanceBaseUrl("https://git.internal/bitbucket", addresses(["10.0.0.5"]))).toBeUndefined();
  expect(await resolveInstanceBaseUrl("https://git.internal/bitbucket", addresses(["203.0.113.10", "10.0.0.5"]))).toBeUndefined();
  expect(await resolveInstanceBaseUrl("https://git.internal/bitbucket", async function fail() { throw new Error("servfail"); })).toBeUndefined();
  expect(await resolveInstanceBaseUrl("https://git.internal/bitbucket", addresses([]))).toBeUndefined();
  expect(await resolveInstanceBaseUrl("https://git.internal/bitbucket", addresses(["::ffff:10.0.0.5"]))).toBeUndefined();
  expect(await resolveInstanceBaseUrl("https://git.example/bitbucket", addresses(["203.0.113.10"]))).toBe("https://git.example/bitbucket");
});

test("the allowlist unlocks a private or loopback host, not link-local, unspecified, or metadata", async () => {
  const listed = ["git.internal", "10.0.0.5", "169.254.169.254", "metadata.google.internal", "::1"];
  expect(await resolveInstanceBaseUrl("http://git.internal:7990", addresses(["10.0.0.5"]), listed)).toBe("http://git.internal:7990");
  expect(await resolveInstanceBaseUrl("http://Git.Internal:7990", addresses(["10.0.0.5"]), ["GIT.INTERNAL"])).toBe("http://git.internal:7990");
  expect(await resolveInstanceBaseUrl("http://git.internal:7990", addresses(["10.0.0.5"]))).toBeUndefined();
  expect(instanceBaseUrl("http://10.0.0.5:7990", ["10.0.0.5"])).toBe("http://10.0.0.5:7990");
  expect(instanceBaseUrl("http://10.0.0.5:7990")).toBeUndefined();
  expect(await resolveInstanceBaseUrl("http://10.0.0.5:7990", addresses(["203.0.113.10"]), ["10.0.0.5"])).toBe("http://10.0.0.5:7990");
  expect(instanceBaseUrl("http://169.254.169.254/latest", listed)).toBeUndefined();
  expect(instanceBaseUrl("http://[fe80::1]", ["fe80::1"])).toBeUndefined();
  expect(instanceBaseUrl("http://0.0.0.0", ["0.0.0.0"])).toBeUndefined();
  expect(instanceBaseUrl("http://[::]", ["::"])).toBeUndefined();
  expect(await resolveInstanceBaseUrl("http://git.internal", addresses(["169.254.169.254"]), ["git.internal"])).toBeUndefined();
  expect(await resolveInstanceBaseUrl("http://metadata.google.internal", addresses(["203.0.113.10"]), listed)).toBeUndefined();
  expect(await resolveInstanceBaseUrl("http://[::1]", addresses(["203.0.113.10"]), listed)).toBe("http://[::1]");
});
