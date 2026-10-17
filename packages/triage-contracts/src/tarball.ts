/** The package-registry file a package version is published as, named the way `npm pack` names it. */
export function tarballFilename(pkg: { name: string; version: string }): string {
  return `${pkg.name.replace("/", "-")}-${pkg.version}.tgz`;
}
