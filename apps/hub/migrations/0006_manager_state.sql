-- Each pull request's manager claim and the events waiting for it.
CREATE TABLE IF NOT EXISTS "corbits_triage"."manager_state" (
  "tenant_id" text NOT NULL REFERENCES "public"."tenant"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "kind" text NOT NULL CHECK ("kind" IN ('claim', 'event')),
  "state" jsonb NOT NULL,
  PRIMARY KEY ("tenant_id", "key")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "manager_state_pending_idx"
  ON "corbits_triage"."manager_state" ("tenant_id")
  WHERE "kind" = 'event' AND "state"->>'consumedBy' IS NULL;
