import { createHash } from "node:crypto";
import { getPool, type DbClient, type DbPool } from "./db";
import { removeFileByKey, type StoredFile } from "./files";
import { LOGIN_PHOTO_ASSET } from "./login-photo";
import { storageKey } from "./storage";

/**
 * Content-addressed storage ownership protocol (peer-review finding #6/#8).
 *
 * Files are deduplicated by SHA-256, so one object can be shared by several rows and
 * a blind unlink after a rollback is unsafe. The protocol:
 *
 *  1. Every uploader computes the planned key BEFORE writing and holds a SHARED
 *     PostgreSQL advisory lock on that key until its referencing row has committed
 *     (or its transaction has rolled back):
 *       - transactional writers: `holdStorageKeyShared(client, key)` (xact lock);
 *       - non-transactional legacy writers: `withStorageKeyGuard(pool, key, fn)`.
 *  2. After a failed/refused attempt (outside the writer's transaction), the writer
 *     calls `cleanupUncommittedStoredFile(stored)`. Cleanup takes the EXCLUSIVE lock
 *     (so it waits for every in-flight uploader of the same content), re-checks every
 *     referencing table under that lock, and unlinks only a file that THIS attempt
 *     created (`deduplicated === false`) and nothing committed references.
 *
 * A pre-existing (deduplicated) object is never removed by a rollback.
 */
export function storageObjectLockKey(key: string): string {
  return `aqlan.storage.object.v1:${key}`;
}

export function plannedStorageKey(bytes: Buffer, extension: string): string {
  return storageKey(createHash("sha256").update(bytes).digest("hex"), extension);
}

export async function holdStorageKeyShared(client: Pick<DbClient, "query">, key: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock_shared(hashtextextended($1, 0))", [storageObjectLockKey(key)]);
}

export async function withStorageKeyGuard<T>(pool: DbPool, key: string, fn: () => Promise<T>): Promise<T> {
  const lockClient = await pool.connect();
  try {
    await lockClient.query("SELECT pg_advisory_lock_shared(hashtextextended($1, 0))", [storageObjectLockKey(key)]);
    try {
      return await fn();
    } finally {
      await lockClient
        .query("SELECT pg_advisory_unlock_shared(hashtextextended($1, 0))", [storageObjectLockKey(key)])
        .catch(() => {});
    }
  } finally {
    lockClient.release();
  }
}

const REFERENCE_SQL = `SELECT (
   EXISTS (SELECT 1 FROM patient_documents WHERE storage_key = $1)
   OR EXISTS (SELECT 1 FROM expense_attachments WHERE storage_key = $1)
   OR EXISTS (SELECT 1 FROM settings WHERE key = $2 AND strpos(value, $1) > 0)
   OR EXISTS (SELECT 1 FROM messages WHERE voice_data = $3 OR file_data = $3)
 ) AS referenced`;

/**
 * Removes a file written by a failed attempt iff it was newly created by that attempt
 * and no committed row references it. MUST be called after the writer's own
 * transaction has ended (its shared lock released); never inside it.
 */
export async function cleanupUncommittedStoredFile(
  stored: StoredFile | null | undefined,
  pool: DbPool = getPool(),
): Promise<boolean> {
  if (!stored || stored.deduplicated) return false;
  let client: Awaited<ReturnType<DbPool["connect"]>> | null = null;
  try {
    client = await pool.connect();
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '10s'");
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [storageObjectLockKey(stored.key)]);
    const { rows } = await client.query<{ referenced: boolean }>(REFERENCE_SQL, [
      stored.key,
      LOGIN_PHOTO_ASSET,
      `storage:${stored.key}`,
    ]);
    let removed = false;
    if (rows[0]?.referenced === false) {
      // Unlink while still holding the exclusive lock: no uploader can adopt the
      // object between the reference check and the removal.
      removed = await removeFileByKey(stored.key);
    }
    await client.query("COMMIT");
    return removed;
  } catch {
    if (client) await client.query("ROLLBACK").catch(() => {});
    // Fail safe: an unverifiable state keeps the file (an orphan is recoverable,
    // a deleted shared object is not).
    return false;
  } finally {
    client?.release();
  }
}
