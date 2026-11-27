import { getPool } from "./db";
import { ASSISTANT_MODE_KEYS } from "./assistant-modes";

// A stop switch must be read from PostgreSQL, not from the per-process settings
// cache. Read only these non-secret keys; on failure the routes stop both modes.
export async function readAssistantControlSettings(): Promise<Record<string, string>> {
  const keys = [...ASSISTANT_MODE_KEYS, "ai.clinical_external"];
  const { rows } = await getPool().query<{ key: string; value: string }>(
    "SELECT key, value FROM settings WHERE key = ANY($1::text[])", [keys],
  );
  return Object.fromEntries(rows.map(row => [row.key, row.value]));
}
