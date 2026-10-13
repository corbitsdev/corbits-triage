CREATE SCHEMA IF NOT EXISTS "corbits_triage";
--> statement-breakpoint
-- Earlier builds kept these tables in the host schema as corbits_triage_<name>.
-- Each one present moves here with its rows, keys and indexes, and its
-- constraints and indexes lose the prefix so it matches a fresh install.
DO $$
DECLARE
  moved text;
  old regclass;
  name text;
BEGIN
  FOREACH moved IN ARRAY ARRAY['verdict', 'do_run', 'invitation'] LOOP
    old := to_regclass('"public"."corbits_triage_' || moved || '"');
    CONTINUE WHEN old IS NULL;
    EXECUTE format('ALTER TABLE %s SET SCHEMA "corbits_triage"', old);
    EXECUTE format('ALTER TABLE "corbits_triage".%I RENAME TO %I', 'corbits_triage_' || moved, moved);
    FOR name IN SELECT conname FROM pg_constraint WHERE conrelid = old AND starts_with(conname, 'corbits_triage_') LOOP
      EXECUTE format('ALTER TABLE "corbits_triage".%I RENAME CONSTRAINT %I TO %I', moved, name, substr(name, 16));
    END LOOP;
    FOR name IN SELECT c.relname FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = old AND starts_with(c.relname, 'corbits_triage_') LOOP
      EXECUTE format('ALTER INDEX "corbits_triage".%I RENAME TO %I', name, substr(name, 16));
    END LOOP;
  END LOOP;
END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corbits_triage"."verdict" (
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "run_id" text NOT NULL,
  "repo" text NOT NULL,
  "number" integer NOT NULL,
  "head_sha" text NOT NULL,
  "started_at" timestamptz NOT NULL,
  "verdict_at" timestamptz NOT NULL,
  "settled" boolean NOT NULL,
  "state" text NOT NULL,
  "actor" text NOT NULL,
  "human_gated" boolean NOT NULL,
  "degraded" text,
  "checks" jsonb NOT NULL,
  "dos" jsonb NOT NULL,
  "commented" boolean NOT NULL,
  "detail" jsonb,
  "trigger" text,
  "run_status" text,
  PRIMARY KEY ("tenant_id", "run_id", "repo", "number")
);
--> statement-breakpoint
-- A hub from a build older than these columns moved its table without them.
ALTER TABLE "corbits_triage"."verdict" ADD COLUMN IF NOT EXISTS "detail" jsonb;
--> statement-breakpoint
ALTER TABLE "corbits_triage"."verdict" ADD COLUMN IF NOT EXISTS "trigger" text;
--> statement-breakpoint
ALTER TABLE "corbits_triage"."verdict" ADD COLUMN IF NOT EXISTS "run_status" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verdict_repo_idx"
  ON "corbits_triage"."verdict" ("tenant_id", "repo", "verdict_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "verdict_pull_idx"
  ON "corbits_triage"."verdict" ("tenant_id", "repo", "number", "verdict_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "corbits_triage"."invitation" (
  "id" text PRIMARY KEY,
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "email" text NOT NULL,
  "role_id" text NOT NULL REFERENCES "public"."role"("id") ON DELETE CASCADE,
  "invited_by" text REFERENCES "public"."principal"("id") ON DELETE SET NULL,
  "token_hash" text NOT NULL UNIQUE,
  "token" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL,
  "revoked_at" timestamptz,
  "accepted_at" timestamptz,
  "accepted_by" text REFERENCES "public"."user"("id") ON DELETE SET NULL,
  "emailed_at" timestamptz
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invitation_email_idx"
  ON "corbits_triage"."invitation" ("email", "tenant_id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invitation_open_idx"
  ON "corbits_triage"."invitation" ("tenant_id", lower("email"))
  WHERE "accepted_at" IS NULL AND "revoked_at" IS NULL;
