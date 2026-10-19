// The hub's owner is its first account. The oldest account stays the oldest, so it is read once.
import { asc } from "drizzle-orm";
import { schema, type DB } from "@intx/db";

export type IsHubOwner = (userId: string) => Promise<boolean>;

export function createHubOwner(db: DB["db"]): IsHubOwner {
  let firstUserId: string | undefined;

  return async function isHubOwner(userId: string): Promise<boolean> {
    if (firstUserId === undefined) {
      const [first] = await db.select({ id: schema.user.id }).from(schema.user).orderBy(asc(schema.user.createdAt), asc(schema.user.id)).limit(1);
      firstUserId = first?.id;
    }
    return firstUserId === userId;
  };
}
