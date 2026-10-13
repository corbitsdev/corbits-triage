-- Approving a pull request is the approve Do kind's grant now, `invoke` on `triage-do:approve:<owner>/<name>`;
-- the system admin role, which held approve everywhere, holds every Do kind's grant.
UPDATE "public"."grant" g SET "resource" = 'triage-do:*', "action" = 'invoke'
  FROM "public"."role" r
  WHERE g."role_id" = r."id" AND r."name" = 'admin' AND r."is_system" AND g."resource" = 'github-review:*' AND g."action" = 'approve';
--> statement-breakpoint
UPDATE "public"."grant" SET "resource" = 'triage-do:approve:' || substr("resource", 15), "action" = 'invoke'
  WHERE "resource" LIKE 'github-review:%' AND "action" = 'approve';
