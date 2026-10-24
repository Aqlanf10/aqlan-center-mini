// Runs ../prerequisites.sql (read-only, ends in ROLLBACK) on a connected pg client and returns its rows.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prerequisites.sql"), "utf8");

/** @param {import("pg").Client} client
 * @returns {Promise<{ rows: Array<{ check_id: string, ok: boolean, detail: string }>, failing: string[], lockedRelations: Array<{ locked_relation: string, mode: string }> }>} */
export async function runPrerequisites(client) {
  const results = /** @type {any} */ (await client.query(SQL));
  const sets = [results].flat();
  const rows = sets.find((r) => r.rows?.[0]?.check_id)?.rows ?? [];
  if (!rows.length) throw new Error("prerequisites.sql returned no rows");
  const lockedRelations = sets.find((r) => r.fields?.some((/** @type {any} */ f) => f.name === "locked_relation"))?.rows ?? [];
  return { rows, failing: rows.filter((/** @type {any} */ r) => !r.ok).map((/** @type {any} */ r) => r.check_id).sort(), lockedRelations };
}
