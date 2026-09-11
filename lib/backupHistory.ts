import path from "node:path";
import { atomicWriteJson, backupStateDir, readJsonFile } from "./backupVolume";
import type { DestinationResult } from "./backupDestinations";

/**
 * سجل النسخ الاحتياطي — على القرص الدائم لا في قاعدة الإنتاج.
 *
 * ما يحمله السجل: هوية كل نسخةٍ مُتحققة (id/تاريخ/بصمات/مقاس/عدد مستندات)
 * ونتائج وجهاتها. ما لا يحمله أبدًا: محتوى مريضٍ واحد، مسار مطلق، رمز، أو
 * أي سر — السجل شهادةُ سلامة لا صورةٌ للمحتوى.
 *
 * والقيد التشغيلي: قبل موافقة بوابة الهجرة لا تُكتب صفوفٌ جديدة في قاعدة
 * الإنتاج من أجل بيانات المجدول — لذلك يسكن السجل ملفًّا ذرّيًّا داخل
 * مجلد النسخ نفسه، وينتقل إلى القاعدة لاحقًا إن رأى المالك.
 */

export const HISTORY_FILE_NAME = "history.json";

/** السجل مقيد الطول: نُبقي آخر 500 سجل — كفاية تاريخية بلا تضخم بلا نهاية. */
const HISTORY_MAX_RECORDS = 500;

export type BackupRecordStatus = "verified" | "failed" | "deleted";
export type ReplicationStatus = "complete" | "partial" | "none";
export type BackupTriggerType = "manual" | "scheduled";

export interface BackupHistoryRecord {
  /** اسم الأرشيف داخل مجلد backups — هوية النسخة. */
  backupId: string;
  createdAt: string;
  triggerType: BackupTriggerType;
  archiveSha256: string;
  archiveBytes: number;
  databaseSha256: string;
  documentCount: number;
  status: BackupRecordStatus;
  replicationStatus: ReplicationStatus;
  destinations: DestinationResult[];
  /** تعيين عند حذف الأرشيف بالاحتفاظ (retention) — السجل يبقى شهادةً. */
  deletedAt?: string;
}

export interface BackupHistory {
  records: BackupHistoryRecord[];
}

export async function readBackupHistory(
  backupDir: string,
): Promise<BackupHistoryRecord[]> {
  const result = await readJsonFile<BackupHistory>(path.join(backupStateDir(backupDir), HISTORY_FILE_NAME));
  if (!result.ok || !Array.isArray(result.data?.records)) return [];
  return result.data.records;
}

/** إضافة سجل (أو استبدال نسخةٍ بنفس المعرف) ثم تقييد الطول — كتابة ذرّية واحدة. */
export async function upsertBackupHistoryRecord(
  backupDir: string,
  record: BackupHistoryRecord,
): Promise<void> {
  const records = await readBackupHistory(backupDir);
  const filtered = records.filter((existing) => existing.backupId !== record.backupId);
  filtered.push(record);
  filtered.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  const bounded = filtered.slice(0, HISTORY_MAX_RECORDS);
  await atomicWriteJson(path.join(backupStateDir(backupDir), HISTORY_FILE_NAME), { records: bounded } satisfies BackupHistory);
}

/** تعديل سجل قائم (نتائج وجهات، حذف بالاحتفاظ…) — يفشل بهدوء إن غاب. */
export async function updateBackupHistoryRecord(
  backupDir: string,
  backupId: string,
  patch: Partial<Omit<BackupHistoryRecord, "backupId">>,
): Promise<void> {
  const records = await readBackupHistory(backupDir);
  const index = records.findIndex((existing) => existing.backupId === backupId);
  if (index < 0) return;
  records[index] = { ...records[index], ...patch };
  records.sort((first, second) => second.createdAt.localeCompare(first.createdAt));
  await atomicWriteJson(
    path.join(backupStateDir(backupDir), HISTORY_FILE_NAME),
    { records: records.slice(0, HISTORY_MAX_RECORDS) } satisfies BackupHistory,
  );
}

/** آخر نسخة مُتحققة غير محذوفة — إن وُجدت. */
export function newestVerifiedRecord(records: BackupHistoryRecord[]): BackupHistoryRecord | null {
  return records
    .filter((record) => record.status === "verified" && !record.deletedAt)
    .sort((first, second) => second.createdAt.localeCompare(first.createdAt))[0] ?? null;
}
