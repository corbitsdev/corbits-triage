import { lstatSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";
import { addedLines } from "@corbits/common/diff-files";
import { type } from "arktype";
import ignore from "ignore";
import type { ToolFinding, ToolFindings } from "../findings.js";

const DATA_CONFIGS = [".oxlintrc.json", ".oxlintrc.jsonc"];
const CODE_CONFIGS = ["oxlint.config.ts", "oxlint.config.mts", "oxlint.config.cts", "oxlint.config.js", "oxlint.config.mjs", "oxlint.config.cjs"];

const Report = type({
  diagnostics: type({
    message: "string",
    "code?": "string",
    severity: "'error' | 'warning' | 'advice'",
    "help?": "string",
    filename: "string",
    labels: type({ span: { line: "number.integer" } }).array(),
  }).array(),
});

/** Whether `path` is inside `root`, after following links, so a link in the checkout never points the linter outside it. */
async function inside(root: string, path: string): Promise<boolean> {
  try {
    const real = await realpath(path);
    return !relative(root, real).startsWith("..") && (await stat(real)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

async function firstInside(root: string, names: readonly string[]): Promise<string | undefined> {
  for (const name of names) if (await inside(root, join(root, name))) return name;
  return undefined;
}

// Only keys that are data: anything else, `extends`, `jsPlugins` and `options` (type-aware runs a binary) among them, could load code.
const PLUGINS = "'eslint' | 'typescript' | 'unicorn' | 'react' | 'react-perf' | 'nextjs' | 'oxc' | 'import' | 'jsdoc' | 'jest' | 'vitest' | 'jsx-a11y' | 'node' | 'promise' | 'vue'";
const RULES = { "rules?": "Record<string, unknown>", "plugins?": `(${PLUGINS})[]`, "env?": "Record<string, boolean>", "globals?": "Record<string, unknown>" } as const;
const Override = type({ "+": "reject", files: "string[]", ...RULES });
const Config = type({ "+": "reject", "$schema?": "string", "categories?": "Record<string, string>", "settings?": "Record<string, unknown>", "ignorePatterns?": "string[]", "overrides?": Override.array(), ...RULES });

/**
 * The repository's config as data alone, its `$schema` dropped and its ignore patterns applied before oxlint runs, written
 * outside the checkout; override globs are made absolute, since oxlint reads them from the config's folder.
 */
function sanitized(root: string, config: typeof Config.infer) {
  const { categories, settings, rules, plugins, env, globals, ignorePatterns, overrides } = config;
  function rooted(override: typeof Override.infer) {
    return { ...override, files: override.files.map((pattern) => `${root}/${pattern.replace(/^\.\//, "")}`) };
  }
  const data = { categories, settings, rules, plugins, env, globals, ...(overrides && { overrides: overrides.map(rooted) }) };
  return { config: data, ignorePatterns: ignorePatterns ?? [] };
}

/**
 * Runs oxlint over the absolute `files` with `config`, both from a fresh folder outside the checkout with only an absolute
 * PATH, so nothing in the checkout is read as config; `--` keeps a file named like a flag a file.
 */
async function runOxlint(oxlint: string, config: object, files: readonly string[]) {
  // A relative PATH entry would resolve inside the checkout, so a binary the pull request adds could run instead.
  const PATH = (process.env.PATH ?? "").split(":").filter((dir) => isAbsolute(dir)).join(":");
  const resolved = Bun.which(oxlint, { PATH });
  if (resolved === null) throw new Error(`${oxlint} is not on the sidecar's PATH`);
  const dir = await mkdtemp(join(tmpdir(), "oxlint-"));
  try {
    const path = join(dir, ".oxlintrc.json");
    await writeFile(path, JSON.stringify(config));
    const run = Bun.spawn([resolved, "-c", path, "--disable-nested-config", "--format", "json", "--", ...files], { cwd: dir, env: { PATH }, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr] = await Promise.all([new Response(run.stdout).text(), new Response(run.stderr).text(), run.exited]);
    return { stdout, stderr };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const SEVERITY: Record<"error" | "warning" | "advice", ToolFinding["severity"]> = { error: "error", warning: "warning", advice: "notice" };

/** The oxlint findings on lines the diff adds, linting the checkout at `root` with the repository's own data-only config. */
async function lintChanges(oxlint: string, root: string, diff: string): Promise<ToolFindings> {
  try {
    const real = await realpath(root);
    const config = await firstInside(real, DATA_CONFIGS);
    if (config === undefined) return { status: "skipped", reason: (await firstInside(real, CODE_CONFIGS)) ? "config loads code" : "no lint config" };
    const parsed = Config(Bun.JSONC.parse(await readFile(join(real, config), "utf8")));
    if (parsed instanceof type.errors) return { status: "skipped", reason: "config loads code" };
    const { config: data, ignorePatterns } = sanitized(real, parsed);
    const added = addedLines(diff);
    const ignored = ignore().add(ignorePatterns);
    const files: string[] = [];
    for (const path of added.keys()) {
      // A path the diff names but the checkout lacks was misread, so linting the rest would pass a file unseen.
      if (lstatSync(join(real, path), { throwIfNoEntry: false }) === undefined) return { status: "incomplete", reason: `lint: changed file ${JSON.stringify(path)} is not in the checkout` };
      if (!ignored.ignores(path) && (await inside(real, join(real, path)))) files.push(join(real, path));
    }
    if (files.length === 0) return { status: "complete", findings: [] };
    const { stdout, stderr } = await runOxlint(oxlint, data, files);
    const json = stdout.search(/^\{/m);
    const report = json < 0 ? undefined : Report(JSON.parse(stdout.slice(json)));
    if (report === undefined || report instanceof type.errors) return { status: "incomplete", reason: `oxlint: ${`${stderr}${stdout}`.trim().split("\n")[0]}` };
    return {
      status: "complete",
      findings: report.diagnostics.flatMap(function onAddedLine({ message, code, severity, help, filename: absolute, labels }) {
        const filename = relative(real, absolute);
        const line = labels[0]?.span.line;
        if (line === undefined || !added.get(filename)?.has(line)) return [];
        return [{ source: "oxlint", ...(code !== undefined && { rule: code }), path: filename, line, message, severity: SEVERITY[severity], ...(help !== undefined && { fix: help }) }];
      }),
    };
  } catch (err) {
    return { status: "incomplete", reason: `lint: ${(err as Error).message}` };
  }
}

const LintInput = type({ path: "string", diff: "string" });

/** The lint action running `oxlint`: the checkout at `path` linted over the lines `diff` adds. */
export function lintWith(oxlint: string) {
  return async function lint(input: unknown): Promise<ToolFindings> {
    const { path, diff } = LintInput.assert(input);
    return lintChanges(oxlint, path, diff);
  };
}

/** The native oxlint the sidecar image installs, never one from the repository under review. */
export const lint = lintWith("oxlint");
