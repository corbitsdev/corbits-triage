// SPDX-License-Identifier: GPL-2.0-only
//
// Pushes a flat file tree to a hub git asset from the browser. isomorphic-git
// builds the objects and pack; receive-pack is spoken directly because the hub
// answers report-status as bare pkt-lines that isomorphic-git's push rejects.
import { Buffer } from "buffer";
import git, { type HttpClient } from "isomorphic-git";
import LightningFS from "@isomorphic-git/lightning-fs";

globalThis.Buffer ??= Buffer;

const MAIN = "refs/heads/main";
const NO_COMMIT = "0".repeat(40);
const AUTHOR = { name: "Corbits Triage", email: "triage@corbits.dev", timezoneOffset: 0 };

const utf8 = new TextEncoder();

function pkt(line: string): Uint8Array {
  const body = utf8.encode(line);
  return concat([utf8.encode((body.length + 4).toString(16).padStart(4, "0")), body]);
}

function concat(parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, part) => n + part.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function pktLines(bytes: Uint8Array): string[] {
  const text = new TextDecoder();
  const lines: string[] = [];
  for (let at = 0; at + 4 <= bytes.length;) {
    const size = Number.parseInt(text.decode(bytes.subarray(at, at + 4)), 16);
    if (Number.isNaN(size)) throw new Error("Malformed git response from the hub.");
    if (size > 4) lines.push(text.decode(bytes.subarray(at + 4, at + size)));
    at += Math.max(size, 4);
  }
  return lines;
}

async function* single(bytes: Uint8Array): AsyncIterableIterator<Uint8Array> {
  yield bytes;
}

function bufferedHttp(): HttpClient {
  return {
    async request({ url, method = "GET", headers = {}, body }) {
      const chunks: Uint8Array[] = [];
      if (body) for await (const chunk of body) chunks.push(chunk);
      const response = await fetch(url, { method, headers, ...(chunks.length ? { body: concat(chunks) } : {}) });
      const bytes = new Uint8Array(await response.arrayBuffer());
      return {
        url,
        method,
        statusCode: response.status,
        statusMessage: response.statusText,
        headers: Object.fromEntries(response.headers.entries()),
        body: single(bytes),
      };
    },
  };
}

async function remoteMain(url: string, auth: Record<string, string>): Promise<string> {
  const response = await fetch(`${url}/info/refs?service=git-receive-pack`, { headers: auth });
  if (!response.ok) throw new Error(`Could not read the workflow source on the hub (HTTP ${response.status}).`);
  for (const line of pktLines(new Uint8Array(await response.arrayBuffer()))) {
    const [sha, ref] = line.split(" ", 2);
    if (sha && ref?.split("\0")[0]?.trim() === MAIN) return sha;
  }
  return NO_COMMIT;
}

/** Commits `files` on top of the asset's `main`, unless `main` already holds them. */
export async function pushFiles({ url, token, files, message }: {
  url: string;
  token: string;
  files: Readonly<Record<string, string>>;
  message: string;
}): Promise<{ commitSha: string; changed: boolean }> {
  const auth = { Authorization: `Bearer ${token}` };
  const fs = new LightningFS(`triage-push-${crypto.randomUUID()}`, { wipe: true });
  const dir = "/repo";
  await git.init({ fs, dir, defaultBranch: "main" });

  async function writeBlob([path, contents]: [string, string]) {
    return {
      mode: "100644",
      path,
      type: "blob" as const,
      oid: await git.writeBlob({ fs, dir, blob: utf8.encode(contents) }),
    };
  }
  const blobs = await Promise.all(Object.entries(files).map(writeBlob));
  const tree = await git.writeTree({ fs, dir, tree: blobs });

  const parent = await remoteMain(url, auth);
  if (parent !== NO_COMMIT) {
    await git.addRemote({ fs, dir, remote: "origin", url });
    await git.fetch({ fs, dir, http: bufferedHttp(), remote: "origin", ref: "main", singleBranch: true, tags: false, headers: auth });
    const { commit } = await git.readCommit({ fs, dir, oid: parent });
    if (commit.tree === tree) return { commitSha: parent, changed: false };
  }

  const timestamp = Math.floor(Date.now() / 1000);
  const commitSha = await git.writeCommit({
    fs,
    dir,
    commit: {
      message,
      tree,
      parent: parent === NO_COMMIT ? [] : [parent],
      author: { ...AUTHOR, timestamp },
      committer: { ...AUTHOR, timestamp },
    },
  });
  const { packfile } = await git.packObjects({ fs, dir, oids: [commitSha, tree, ...blobs.map((blob) => blob.oid)] });
  if (!packfile) throw new Error("Could not pack the workflow source.");

  const response = await fetch(`${url}/git-receive-pack`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/x-git-receive-pack-request" },
    body: concat([pkt(`${parent} ${commitSha} ${MAIN}\0report-status\n`), utf8.encode("0000"), packfile]),
  });
  if (!response.ok) throw new Error(`The hub refused the workflow source (HTTP ${response.status}).`);
  const report = pktLines(new Uint8Array(await response.arrayBuffer())).map((line) => line.trim());
  if (!report.includes("unpack ok") || !report.includes(`ok ${MAIN}`)) {
    throw new Error(`The hub refused the workflow source: ${report.join("; ")}`);
  }
  return { commitSha, changed: true };
}
