// The live SidecarRouter (the one sessions and the websocket endpoint use) is
// required here, so a hook route can never silently boot unroutable.
import type { createPrincipalKeyStore, DB } from "@intx/db";
import type { CredentialCipher } from "@intx/types";
import { createHookRoutes, type HookRouter } from "@corbits/webhooks";
import { runWebhookMigrations } from "@corbits/webhooks/migrations";
import type { DatabaseConfig } from "./env.js";

export const HOOK_MOUNT_PATH = "/api/hooks";

/** Must run after Interchange's own migrations. */
export async function migrateWebhooks({ schema = "public", statementTimeoutMs: _, ...database }: DatabaseConfig): Promise<void> {
  await runWebhookMigrations(database, { schema });
  console.log("webhook migrations applied");
}

export interface HookDeps {
  db: DB["db"];
  cipher: CredentialCipher;
}

export function createStockHookApp(
  deps: HookDeps,
  principalKeyStore: ReturnType<typeof createPrincipalKeyStore>,
  router: HookRouter,
) {
  return createHookRoutes({
    db: deps.db,
    credentialCipher: deps.cipher,
    principalKeyStore,
    router,
  });
}
