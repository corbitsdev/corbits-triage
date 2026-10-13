-- better-auth's deviceAuthorization plugin: codes an agent asks for and a signed-in person approves.
CREATE TABLE IF NOT EXISTS "corbits_triage"."device_code" (
  "id" text PRIMARY KEY,
  "device_code" text NOT NULL UNIQUE,
  "user_code" text NOT NULL UNIQUE,
  "user_id" text REFERENCES "public"."user"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "status" text NOT NULL,
  "last_polled_at" timestamptz,
  "polling_interval" integer,
  "client_id" text,
  "scope" text
);
