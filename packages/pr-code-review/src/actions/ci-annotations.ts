import { getCodeInsightsAnnotations, type CodeInsightsAnnotation } from "@corbits/bitbucket-datacenter-reads";
import { getCheckAnnotations, type CheckAnnotation } from "@corbits/github-reads";
import type { EffectContext, PerformScope } from "@intx/workflow";
import type { ToolFinding, ToolFindings } from "../findings.js";
import { Checkout, READ_REPOSITORY } from "./checkout.js";

type HostFetch = (path: string, init?: RequestInit) => Promise<Response>;

const LEVEL: Record<CheckAnnotation["annotation_level"], ToolFinding["severity"]> = { failure: "error", warning: "warning", notice: "notice" };

const SEVERITY: Record<CodeInsightsAnnotation["severity"], ToolFinding["severity"]> = { HIGH: "error", MEDIUM: "warning", LOW: "notice" };

export function fromCheckAnnotation({ check, title, path, start_line, message, annotation_level }: CheckAnnotation): ToolFinding {
  return { source: check, ...(title && { rule: title }), path, line: start_line, message, severity: LEVEL[annotation_level] };
}

/** A report-wide annotation names no file, so it is left out; line 0 is about the whole file. */
export function fromCodeInsights({ report, type: rule, path, line, message, severity }: CodeInsightsAnnotation): ToolFinding[] {
  if (path === undefined) return [];
  return [{ source: report, ...(rule !== undefined && { rule }), path, ...(line !== undefined && line > 0 && { line }), message, severity: SEVERITY[severity] }];
}

const READ: Record<Checkout["source"], (host: HostFetch, checkout: Checkout) => Promise<ToolFinding[]>> = {
  async github(host, { repo, sha }) {
    return (await getCheckAnnotations(host, repo, sha)).map(fromCheckAnnotation);
  },
  async "bitbucket-datacenter"(host, { repo, sha }) {
    return (await getCodeInsightsAnnotations(host, repo, sha)).flatMap(fromCodeInsights);
  },
};

/** The head's CI annotations; a read that fails leaves them incomplete rather than empty. */
export async function readCiAnnotations(host: HostFetch, checkout: Checkout): Promise<ToolFindings> {
  try {
    return { status: "complete", findings: await READ[checkout.source](host, checkout) };
  } catch (err) {
    return { status: "incomplete", reason: `ci annotations: ${(err as Error).message}` };
  }
}

/** The ciAnnotations action: GitHub check-run annotations or Code Insights annotations on the head, read through the host's credential. */
export async function ciAnnotations(input: unknown, ctx: EffectContext): Promise<ToolFindings> {
  const checkout = Checkout.assert(input);
  async function run({ credentials }: PerformScope) {
    const mediated = await credentials.resolve(checkout.source);
    if (mediated.kind !== "http") throw new Error(`${checkout.source} credential must be http, got ${mediated.kind}`);
    function host(path: string, init?: RequestInit) {
      return mediated.fetch(path, init);
    }
    return readCiAnnotations(host, checkout);
  }
  return (await ctx.perform({ effectId: "ci-annotations", capability: READ_REPOSITORY, run })) as ToolFindings;
}
