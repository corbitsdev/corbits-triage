import { resolve } from "node:path";
import { childProcessEnv, databaseConfig, loadDatabaseEnv, migrationEnv } from "./env.js";
import { configureObservability, logJson } from "./observability.js";
import { migrateDatabase } from "./migrations.js";

const env = loadDatabaseEnv(process.env);
const database = databaseConfig(env);

const observability = await configureObservability({ telemetry: [], errors: [], notifications: [] }, { development: env.NODE_ENV !== "production" });
try {
  await Bun.$`bunx --no-install drizzle-kit migrate`
    .cwd(resolve(import.meta.dir, "../../../vendor/interchange/packages/db"))
    .env({ ...childProcessEnv(env), ...migrationEnv(database) });

  await migrateDatabase(database, logJson);
} finally {
  await observability.shutdown();
}
