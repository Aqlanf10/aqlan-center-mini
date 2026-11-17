import type { Pool } from "pg";
import { applyRuntimeMigrationFiles, loadMigrationFiles, validateRuntimeHistorical0079 } from "../../lib/migrations";

/** Only on a freshly owned canonical journey fixture; never a live target. */
export async function prepareHistoricalCoverage(pool: Pool): Promise<void> {
  const database = (await pool.query<{ name: string }>("SELECT current_database() AS name")).rows[0]?.name;
  if (!database || !/^aqlan_backup_precision_[a-f0-9]{32}$/.test(database)) throw new Error("Historical coverage requires an owned synthetic journey database");
  const file = (await loadMigrationFiles()).find(item => item.version === "0079");
  if (!file) throw new Error("Historical 0079 source missing");
  await applyRuntimeMigrationFiles(pool, [file]);
  const records = (await pool.query("SELECT version,name,checksum,adopted FROM schema_migrations WHERE version='0079'")).rows;
  if (records.length !== 1 || records[0].version !== file.version || records[0].name !== file.name || records[0].checksum !== file.checksum || records[0].adopted !== false) {
    throw new Error("Synthetic historical 0079 registry differs from its source");
  }
  await validateRuntimeHistorical0079(pool, file);
}
