-- A Do grant names its host, `triage-do:<kind>:<source>:<owner>/<name>`, so two hosts that share a repository name do not share a row.
-- The existing row moves onto GitHub when that host has the repository, otherwise onto Bitbucket Data Center, and the other host gets a copy; a grant whose repository is not recorded is left as it was.
WITH "repos" AS (
  SELECT t."id" AS "tenant_id",
         lower(repo->>'name') AS "name",
         CASE WHEN repo->>'source' = 'bitbucket-datacenter' THEN 'bitbucket-datacenter' ELSE 'github' END AS "source"
  FROM "public"."tenant" t
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(t."config"->'corbitsTriage'->'repos') = 'array'
         THEN t."config"->'corbitsTriage'->'repos'
         ELSE '[]'::jsonb END
  ) AS repo
  WHERE jsonb_typeof(repo) = 'object'
    AND jsonb_typeof(repo->'name') = 'string'
    AND length(repo->>'name') > 0
    AND jsonb_typeof(repo->'connected') = 'boolean'
),
"old" AS (
  SELECT g."id", g."tenant_id", g."role_id", g."principal_id", g."action", g."effect", g."conditions", g."origin", g."expires_at", g."created_at",
         split_part(g."resource", ':', 2) AS "kind",
         lower(split_part(g."resource", ':', 3)) AS "repo_lower"
  FROM "public"."grant" g
  WHERE g."resource" ~ '^triage-do:(labels|assign|request-review|comment|approve|request-changes|close|merge):[^:/]+/[^:/]+$'
),
"matched" AS (
  SELECT DISTINCT o."id", r."source"
  FROM "old" o
  JOIN "repos" r ON r."tenant_id" = o."tenant_id" AND r."name" = o."repo_lower"
),
"keepers" AS (
  SELECT "id", CASE WHEN bool_or("source" = 'github') THEN 'github' ELSE 'bitbucket-datacenter' END AS "source"
  FROM "matched"
  GROUP BY "id"
),
"rewritten" AS (
  UPDATE "public"."grant" g
  SET "resource" = 'triage-do:' || o."kind" || ':' || k."source" || ':' || o."repo_lower",
      "updated_at" = now()
  FROM "old" o
  JOIN "keepers" k ON k."id" = o."id"
  WHERE g."id" = o."id"
  RETURNING g."id"
)
INSERT INTO "public"."grant" ("id", "tenant_id", "role_id", "principal_id", "resource", "action", "effect", "conditions", "origin", "expires_at", "created_at", "updated_at")
SELECT 'grt_' || md5(o."id" || ':' || m."source"),
       o."tenant_id", o."role_id", o."principal_id",
       'triage-do:' || o."kind" || ':' || m."source" || ':' || o."repo_lower",
       o."action", o."effect", o."conditions", o."origin", o."expires_at", o."created_at", now()
FROM "old" o
JOIN "matched" m ON m."id" = o."id"
JOIN "keepers" k ON k."id" = o."id" AND k."source" IS DISTINCT FROM m."source"
WHERE (SELECT count(*) FROM "rewritten") >= 0
  AND NOT EXISTS (
    SELECT 1 FROM "public"."grant" existing
    WHERE existing."tenant_id" = o."tenant_id"
      AND existing."role_id" IS NOT DISTINCT FROM o."role_id"
      AND existing."principal_id" IS NOT DISTINCT FROM o."principal_id"
      AND existing."action" = o."action"
      AND existing."resource" = 'triage-do:' || o."kind" || ':' || m."source" || ':' || o."repo_lower"
  );
