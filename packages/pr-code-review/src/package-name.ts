/** Set by the workflow build to the published package name; source runs use the provider's workspace package. */
declare const WORKFLOW_PACKAGE_NAME: string | undefined;

/** Director ids are namespaced by the package that publishes them, one per provider and host. */
export function packageName(workspacePackage: string): string {
  return typeof WORKFLOW_PACKAGE_NAME === "undefined" ? workspacePackage : WORKFLOW_PACKAGE_NAME;
}
