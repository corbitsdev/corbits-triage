import { Glob } from "bun";

const exact = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;
const gitSha = /#[0-9a-f]{40}$/;
const fields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
  "resolutions",
  "catalog",
];

function isPinned(spec: string): boolean {
  return (
    exact.test(spec) ||
    spec.startsWith("workspace:") ||
    spec.startsWith("catalog:") ||
    gitSha.test(spec)
  );
}

const offenders: string[] = [];
for await (const file of new Glob("{package.json,{apps,packages,tooling,e2e}/*/package.json,{tooling,e2e}/package.json}").scan(".")) {
  const manifest = await Bun.file(file).json();
  for (const field of fields) {
    for (const [name, spec] of Object.entries<string>(manifest[field] ?? {})) {
      if (!isPinned(spec)) offenders.push(`${file} ${field} ${name}: ${spec}`);
    }
  }
}

if (offenders.length > 0) {
  console.error(`Dependencies must be exact versions:\n${offenders.join("\n")}`);
  process.exit(1);
}
