import { resolve } from "node:path";
import { childProcessEnv, databaseConfig, migrationEnv } from "./env.js";

const { DATABASE_URL, PATH, HOME, TMPDIR } = process.env;
if (!DATABASE_URL) throw new Error("DATABASE_URL environment variable is required");

await Bun.$`bunx drizzle-kit migrate`
  .cwd(resolve(import.meta.dir, "../../../vendor/interchange/packages/db"))
  .env({ ...childProcessEnv({ PATH, HOME, TMPDIR }), ...migrationEnv(databaseConfig({ DATABASE_URL })) });
