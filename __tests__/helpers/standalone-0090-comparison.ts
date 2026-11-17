import { createHash } from "node:crypto";

/** Test-only: normalize exactly the writer's one verified registry count. */
export function normalizedRegistryCountDigest(dataSql: string, expectedCount: number): string {
  if (!Number.isSafeInteger(expectedCount) || expectedCount < 0) throw new Error("Invalid expected registry count");
  const matches = [...dataSql.matchAll(/^-- schema_migrations \((0|[1-9][0-9]*)\)$/gm)];
  if (matches.length !== 1 || matches[0][1] !== String(expectedCount)) throw new Error("Unexpected registry count comment");
  const normalized = dataSql.replace(/^-- schema_migrations \((0|[1-9][0-9]*)\)$/m, "-- schema_migrations (<verified-count>)");
  return createHash("sha256").update(normalized, "utf8").digest("hex");
}
