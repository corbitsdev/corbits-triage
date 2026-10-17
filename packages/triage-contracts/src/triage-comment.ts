import { type } from "arktype";
import type { ArtifactRef, PolicySource } from "./resolve-policy.js";

/** What a Triage comment was written for, kept in its marker so a later run can tell what changed. */
export type TriageHeader = { head: string; policy: PolicySource | null; verdict: string };

/** One of Triage's marked comments as a host lists it, oldest first. */
export type MarkedComment = { id: number; body: string; updatedAt?: string };

export type WrittenComment = { commentId: number; updated: boolean; unchanged?: string };

/** How one host reads and writes a pull request's comments; `edit` is undefined when the host refuses the edit. */
export type CommentHost = {
  edit(id: number, body: string): Promise<number | undefined>;
  post(body: string): Promise<number>;
};

const ArtifactRefShape = type({ id: "string", version: "number" });
const TriageHeaderShape = type({ head: "string", policy: type({ "repo?": ArtifactRefShape, "shared?": ArtifactRefShape, "file?": { path: "string", sha: "string" } }).or("null"), verdict: "string" });

/** How a host writes the header on a Triage comment's first line, so a later run can read it back. */
export type MarkerFormat = {
  current(header: TriageHeader): string;
  /** Starts like the current marker, so the hub still reads it as Triage's own, but is never taken as the current comment. */
  superseded(header: TriageHeader): string;
  /** The header on a marked comment's first line; undefined on one written before headers. */
  headerOf(body: string): TriageHeader | undefined;
  isSuperseded(body: string): boolean;
};

const SUPERSEDES_NOTE = "This supersedes the comment above because the rules changed";
const HTML_SUPERSEDED = "<!-- corbits-triage-superseded";

export function parseHeader(json: string): TriageHeader | undefined {
  try {
    const parsed = TriageHeaderShape(JSON.parse(json));
    return parsed instanceof type.errors ? undefined : parsed;
  } catch {
    return undefined;
  }
}

/** GitHub hides an HTML comment, so the header rides in one. */
export const HTML_MARKERS: MarkerFormat = {
  current(header) {
    return `<!-- corbits-triage ${JSON.stringify(header)} -->`;
  },
  superseded(header) {
    return `${HTML_SUPERSEDED} ${JSON.stringify(header)} -->`;
  },
  headerOf(body) {
    const match = /^<!-- corbits-triage(?:-superseded)? (\{.*\}) -->/.exec(body);
    return match ? parseHeader(match[1]!) : undefined;
  },
  isSuperseded(body) {
    return body.startsWith(HTML_SUPERSEDED);
  },
};

/** The text below the marker, less a supersede note, so a rerun compares only what it renders. */
function renderedText(body: string): string {
  const text = body.slice(body.indexOf("\n") + 1);
  return text.startsWith(SUPERSEDES_NOTE) ? text.slice(text.indexOf("\n\n") + 2) : text;
}

function sameRef(a: ArtifactRef | undefined, b: ArtifactRef | undefined): boolean {
  return a?.id === b?.id && a?.version === b?.version;
}

function samePolicy(a: PolicySource | null, b: PolicySource | null): boolean {
  return sameRef(a?.repo, b?.repo) && sameRef(a?.shared, b?.shared) && a?.file?.sha === b?.file?.sha;
}

/** The rules changed under an unchanged head and changed its verdict, so the earlier comment is history rather than stale. */
function supersedes(before: TriageHeader, after: TriageHeader): boolean {
  return before.head === after.head && before.verdict !== after.verdict && !samePolicy(before.policy, after.policy);
}

function versionChange(name: string, before: ArtifactRef | undefined, after: ArtifactRef | undefined): string[] {
  if (sameRef(before, after)) return [];
  return [`${name} ${before ? `version ${before.version}` : "none"} → ${after ? `version ${after.version}` : "none"}`];
}

function fileChange(before: PolicySource | null, after: PolicySource | null): string[] {
  const [was, now] = [before?.file?.sha.slice(0, 7), after?.file?.sha.slice(0, 7)];
  return was === now ? [] : [`policy file ${was ?? "none"} → ${now ?? "none"}`];
}

function supersedesNote(before: TriageHeader, after: TriageHeader): string {
  const changes = [...versionChange("repository policy", before.policy?.repo, after.policy?.repo), ...versionChange("workspace policy", before.policy?.shared, after.policy?.shared), ...fileChange(before.policy, after.policy)];
  return `${SUPERSEDES_NOTE}: ${changes.join(", ")}.`;
}

function unchangedSince(markers: MarkerFormat, latest: MarkedComment, header: TriageHeader, text: string): string | undefined {
  const before = markers.headerOf(latest.body);
  if (!before || before.head !== header.head || before.verdict !== header.verdict || !samePolicy(before.policy, header.policy)) return undefined;
  return renderedText(latest.body) === text ? latest.updatedAt : undefined;
}

/**
 * The header the new comment supersedes: the current one's once it is marked superseded, or, when a retry finds no
 * current comment, the last superseded one's, so the new comment still names what changed.
 */
function earlierHeader(markers: MarkerFormat, own: MarkedComment[], current: MarkedComment[], superseded: boolean): TriageHeader | undefined {
  if (superseded) return markers.headerOf(current[0]!.body);
  if (current.length > 0) return undefined;
  const last = own.at(-1);
  return last && markers.headerOf(last.body);
}

/** Edits the first current comment the host lets it edit, else posts a new one. */
export async function upsertMarked(host: CommentHost, body: string, current: MarkedComment[]): Promise<WrittenComment> {
  for (const candidate of current) {
    const edited = await host.edit(candidate.id, body);
    if (edited !== undefined) return { commentId: edited, updated: true };
  }
  return { commentId: await host.post(body), updated: false };
}

/**
 * Writes nothing when Triage's own comment already says this for this head, policy versions and verdict; supersedes it
 * when only the rules changed the verdict on the same head; otherwise edits it in place. `own` holds only comments
 * Triage itself wrote, so a copied marker never decides what Triage writes. The earlier comment is marked superseded
 * before the new one is posted, so a retry never leaves two current comments.
 */
export async function writeHeadedComment(host: CommentHost, markers: MarkerFormat, own: MarkedComment[], header: TriageHeader, text: string): Promise<WrittenComment> {
  const current = own.filter((c) => !markers.isSuperseded(c.body));
  const latest = current[0];
  const since = latest && unchangedSince(markers, latest, header, text);
  if (latest && since) return { commentId: latest.id, updated: false, unchanged: `unchanged since ${since}` };
  const before = latest && markers.headerOf(latest.body);
  const superseded = before !== undefined && supersedes(before, header)
    && await host.edit(latest!.id, `${markers.superseded(before)}\nSuperseded by the comment below.`) !== undefined;
  const earlier = earlierHeader(markers, own, current, superseded);
  if (earlier && supersedes(earlier, header)) return { commentId: await host.post(`${markers.current(header)}\n${supersedesNote(earlier, header)}\n\n${text}`), updated: false };
  return upsertMarked(host, `${markers.current(header)}\n${text}`, current);
}

const LINK_REFERENCE_PREFIX = "[corbits-triage";
const LINK_REFERENCE_SUPERSEDED = "[corbits-triage-superseded]: #";

/** A host that shows an HTML comment as text gets the header in a CommonMark link reference definition, which renders as nothing. */
export const LINK_REFERENCE_MARKER = "[corbits-triage]: #";

export function isLinkReferenceTriageComment(body: string): boolean {
  return body.startsWith(LINK_REFERENCE_PREFIX);
}

function linkReferenceLine(prefix: string, header: TriageHeader): string {
  return `${prefix}${encodeURIComponent(JSON.stringify(header))}`;
}

export const LINK_REFERENCE_MARKERS: MarkerFormat = {
  current(header) {
    return linkReferenceLine(LINK_REFERENCE_MARKER, header);
  },
  superseded(header) {
    return linkReferenceLine(LINK_REFERENCE_SUPERSEDED, header);
  },
  headerOf(body) {
    const match = /^\[corbits-triage(?:-superseded)?\]: #(\S+)/.exec(body);
    if (!match) return undefined;
    try {
      return parseHeader(decodeURIComponent(match[1]!));
    } catch {
      return undefined;
    }
  },
  isSuperseded(body) {
    return body.startsWith(LINK_REFERENCE_SUPERSEDED);
  },
};
