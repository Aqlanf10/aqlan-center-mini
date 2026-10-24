// Runs ../prerequisites.sql (read-only, ends in ROLLBACK) on a connected pg client and returns its rows.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SQL = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "prerequisites.sql"), "utf8");

/** @param {import("pg").Client} client @returns {Promise<{ rows: Array<{ check_id: string, ok: boolean, detail: string }>, failing: string[] }>} */
export async function runPrerequisites(client) {
  const results = /** @type {any} */ (await client.query(SQL));
  const rows = [results].flat().find((r) => r.rows?.[0]?.check_id)?.rows ?? [];
  if (!rows.length) throw new Error("prerequisites.sql returned no rows");
  return { rows, failing: rows.filter((r) => !r.ok).map((r) => r.check_id).sort() };
}
