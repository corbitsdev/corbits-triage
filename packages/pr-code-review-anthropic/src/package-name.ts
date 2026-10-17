/** Set by the workflow build to the published package name; source runs use the workspace package. */
declare const WORKFLOW_PACKAGE_NAME: string | undefined;

/** Director ids are namespaced by the package that publishes them, one per host. */
export const PACKAGE_NAME = typeof WORKFLOW_PACKAGE_NAME === "undefined" ? "@corbits/pr-code-review-anthropic" : WORKFLOW_PACKAGE_NAME;
