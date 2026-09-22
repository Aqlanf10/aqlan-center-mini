import { unlink } from "node:fs/promises";
import {
  readBackupHistory,
  updateBackupHistoryRecord,
  type BackupHistoryRecord,
} from "./backupHistory";
import { resolveBackupArchivePath } from "./backupVolume";

export type ManualBackupDeleteProtection =
  | "not-found"
  | "only-verified"
  | "latest-verified"
  | "external-anchor";

/**
 * حماية الحذف اليدوي: لا نحذف آخر/أحدث rollback point، ولا آخر نسخة ناجحة
 * لوجهة خارجية. الحذف اليدوي أضيق من retention عمدًا.
 */
export function manualBackupDeleteProtection(
  records: BackupHistoryRecord[],
  backupId: string,
): ManualBackupDeleteProtection | null {
  const active = records
    .filter((record) => record.status === "verified" && !record.deletedAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const target = active.find((record) => record.backupId === backupId);
  if (!target) return "not-found";
  if (active.length <= 1) return "only-verified";
  if (active[0]?.backupId === backupId) return "latest-verified";

  const latestExternalSuccess = new Map<string, string>();
  for (const record of active) {
    for (const destination of record.destinations) {
      if (destination.destination === "railway_volume") continue;
      if (destination.status !== "success") continue;
      if (!latestExternalSuccess.has(destination.destination)) {
        latestExternalSuccess.set(destination.destination, record.backupId);
      }
    }
  }
  if ([...latestExternalSuccess.values()].includes(backupId)) return "external-anchor";
  return null;
}

export type DeleteVerifiedBackupResult =
  | { ok: true; backupId: string; freedBytes: number; deletedAt: string }
  | { ok: false; reason: ManualBackupDeleteProtection | "archive-missing" | "delete-failed" };

/** حذف يدوي محكوم على الـVolume فقط — لا يكتب قاعدة الإنتاج. */
export async function deleteVerifiedBackupArchive(input: {
  backupDir: string;
  backupId: string;
  actor: string;
  reason: string;
}): Promise<DeleteVerifiedBackupResult> {
  const records = await readBackupHistory(input.backupDir);
  const protection = manualBackupDeleteProtection(records, input.backupId);
  if (protection) return { ok: false, reason: protection };

  const target = records.find(
    (record) => record.backupId === input.backupId && record.status === "verified" && !record.deletedAt,
  );
  if (!target) return { ok: false, reason: "not-found" };

  let archivePath: string;
  try {
    archivePath = resolveBackupArchivePath(input.backupDir, input.backupId);
  } catch {
    return { ok: false, reason: "not-found" };
  }

  try {
    await unlink(archivePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") {
      return { ok: false, reason: "archive-missing" };
    }
    return { ok: false, reason: "delete-failed" };
  }

  const deletedAt = new Date().toISOString();
  await updateBackupHistoryRecord(input.backupDir, input.backupId, {
    status: "deleted",
    deletedAt,
    deletedBy: input.actor.slice(0, 120),
    deletionReason: input.reason.trim().slice(0, 500),
  });
  return { ok: true, backupId: input.backupId, freedBytes: target.archiveBytes, deletedAt };
}
