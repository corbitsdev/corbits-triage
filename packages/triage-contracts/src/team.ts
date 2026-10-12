/** A team written `@org/slug` or `slug` as its lowercased slug in the repository owner's org; null when it names another org. GitHub org names and team slugs are case-insensitive. */
export function teamSlug(team: string, repo: string): string | null {
  const [org, slug] = team.replace(/^@/, "").toLowerCase().split("/", 2);
  if (slug === undefined) return org!;
  return org === repo.split("/", 1)[0]!.toLowerCase() ? slug : null;
}
