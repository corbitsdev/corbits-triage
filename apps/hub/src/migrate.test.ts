import { expect, test } from "bun:test";
import { mkdtemp, chmod, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

for (const fails of [false, true]) {
  test(`migration entry point emits structured progress${fails ? " before failure" : " and exits"}`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "corbits-migration-log-"));
    try {
      // Keep the real CLI and logging startup; replace only database operations.
      const bunx = join(directory, "bunx");
      await writeFile(bunx, "#!/bin/sh\nexit 0\n");
      await chmod(bunx, 0o755);
      const preload = join(directory, "preload.ts");
      await writeFile(preload, `
        import { mock } from "bun:test";
        mock.module(${JSON.stringify(join(import.meta.dir, "migrations.ts"))}, function migrations() {
          return { async migrateDatabase(_database: unknown, log: (entry: Record<string, unknown>) => void) {
            log({ level: "info", msg: "artifact_migrations_applied" });
            log({ level: "warn", msg: "migration_warning" });
            ${fails ? 'throw new Error("migration_failure_probe");' : ""}
          } };
        });
      `);
      const child = Bun.spawn([process.execPath, "--conditions=intx-src", "--preload", preload, join(import.meta.dir, "migrate.ts")], {
        env: { DATABASE_URL: "postgres://unused:unused@127.0.0.1:1/unused", PATH: directory, NODE_ENV: "production" },
        stdout: "pipe", stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(exitCode).toBe(fails ? 1 : 0);
      expect(stdout).toContain('"msg":"artifact_migrations_applied"');
      expect(stdout).toContain('"msg":"migration_warning"');
      if (fails) expect(stderr).toContain("migration_failure_probe");
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
}
