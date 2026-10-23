import { type } from "arktype";
import { json, jsonAll, repoParts, type BitbucketFetch } from "./client.js";

const Report = type({ key: "string", title: "string" });

const Annotation = type({
  reportKey: "string",
  "path?": "string",
  "line?": "number.integer",
  message: "string",
  severity: "'LOW' | 'MEDIUM' | 'HIGH'",
  "type?": "string",
});

export type CodeInsightsAnnotation = typeof Annotation.infer & { report: string };

/** The Code Insights annotations on a commit, each with the title of the report it belongs to. */
export async function getCodeInsightsAnnotations(bb: BitbucketFetch, repo: string, sha: string): Promise<CodeInsightsAnnotation[]> {
  const { project, slug } = repoParts(repo);
  const commit = `/rest/insights/1.0/projects/${project}/repos/${slug}/commits/${encodeURIComponent(sha)}`;
  const reports = new Map((await jsonAll(bb, `${commit}/reports`)).map((row) => Report.assert(row)).map((report) => [report.key, report.title]));
  const { annotations } = type({ annotations: Annotation.array() }).assert(await json(bb, `${commit}/annotations`));
  return annotations.map(function withReport(annotation) {
    const report = reports.get(annotation.reportKey);
    if (report === undefined) throw new Error(`bitbucket annotation names an unknown report ${annotation.reportKey}`);
    return { ...annotation, report };
  });
}
