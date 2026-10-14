export function githubHref(href: string | undefined): string | undefined {
  const url = new URL(href ?? "", "https://github.com");
  return url.protocol === "https:" && url.host === "github.com" ? url.href : undefined;
}
