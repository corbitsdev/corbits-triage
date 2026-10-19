/** Every triage workspace's slug is this, or this and a dash and more. */
export const WORKSPACE_SLUG = "corbits-triage";

export function isTriageSlug(slug: string | undefined): boolean {
  return slug === WORKSPACE_SLUG || Boolean(slug?.startsWith(`${WORKSPACE_SLUG}-`));
}
