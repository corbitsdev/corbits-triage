import { runWebhookMigrations } from "@corbits/webhooks/migrations";
import type { DatabaseConfig } from "./env.js";

export const HOOK_MOUNT_PATH = "/api/hooks";

/** Must run after Interchange's own migrations. */
export async function migrateWebhooks({ schema = "public", statementTimeoutMs: _, ...database }: DatabaseConfig, log: (entry: Record<string, unknown>) => void): Promise<void> {
  await runWebhookMigrations(database, { schema });
  log({ level: "info", msg: "webhook_migrations_applied" });
}
