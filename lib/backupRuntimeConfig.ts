import path from "node:path";
import { atomicWriteJson, backupStateDir, readJsonFile } from "./backupVolume";
import {
  VOLUME_BACKUP_CONFIG_FILE_NAME,
  parseVolumeBackupConfigPatch,
  type VolumeBackupConfigPatch,
} from "./backupConfig";

/**
 * قراءة/كتابة ملف تجاوز التكوين الدائم (backup-config.json) — الطبقة الوسطى
 * بين التحقق الصارم (lib/backupConfig، دوال نقية) والقرص (lib/backupVolume).
 *
 * * غائب ⇒ `absent` — لا تجاوز، التكوين من جدول الإعدادات.
 * * تالف ⇒ `corrupt` — والمستدعي التنفيذي يفشل مغلقًا: ملف تكوينٍ لا يُفهم
 *   لا يجوز أن يُتجاهل صامتًا في نظام يُطلق نسخًا.
 * * الكتابة تدمج فوق التجاوز القائم (قيمه الصالحة وحدها) وتكتب ذرّيًّا.
 */

export type VolumeBackupConfigRead =
  | { status: "present"; patch: VolumeBackupConfigPatch }
  | { status: "absent" }
  | { status: "corrupt" };

function volumeBackupConfigPath(backupDir: string): string {
  return path.join(backupStateDir(backupDir), VOLUME_BACKUP_CONFIG_FILE_NAME);
}

export async function readVolumeBackupConfig(backupDir: string): Promise<VolumeBackupConfigRead> {
  const result = await readJsonFile<unknown>(volumeBackupConfigPath(backupDir));
  if (result.ok) {
    const parsed = parseVolumeBackupConfigPatch(result.data);
    return parsed.ok ? { status: "present", patch: parsed.patch } : { status: "corrupt" };
  }
  // غائب = عادي؛ غير مقروء (صلاحيات مثلًا) = تالف بمفعول الفشل المغلق.
  return result.missing ? { status: "absent" } : { status: "corrupt" };
}

/** دمج التصحيح الجديد فوق التجاوز القائم ثم كتابة ذرّية. */
export async function writeVolumeBackupConfig(
  backupDir: string,
  patch: VolumeBackupConfigPatch,
): Promise<VolumeBackupConfigPatch> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(backupStateDir(backupDir), { recursive: true });
  const existing = await readVolumeBackupConfig(backupDir);
  const existingPatch: VolumeBackupConfigPatch = existing.status === "present" ? existing.patch : {};
  const destinations =
    existingPatch.destinations || patch.destinations
      ? { ...(existingPatch.destinations ?? {}), ...(patch.destinations ?? {}) }
      : undefined;
  const merged: VolumeBackupConfigPatch = {
    ...existingPatch,
    ...patch,
    ...(destinations ? { destinations } : {}),
  };
  await atomicWriteJson(volumeBackupConfigPath(backupDir), merged);
  return merged;
}
