import "server-only";
import { readStoredSettingsWith } from "./db";
import { runCanonicalReadSnapshot } from "./canonical-read-snapshot";
import { CanonicalSettingsRefusal, commandCanonicalSettingsWrite, parseCanonicalSettingsUpdate } from "./canonical-settings";
import type { VerifiedDurableSession } from "./staff-durable-session";

const KEY = "display.delay_notice";
export interface CanonicalDisplayNotice { on: boolean; version: string | null; canEdit: boolean }

/** The notice is an operational setting, not a patient/queue/financial grant. */
export async function readCanonicalDisplayNotice(session: VerifiedDurableSession): Promise<CanonicalDisplayNotice> {
  return runCanonicalReadSnapshot(session, "settings.view", async (query, scope) => {
    const row = (await readStoredSettingsWith(query)).get(KEY);
    return { on: row?.value === "true", version: row?.updatedAt ?? null, canEdit: scope.granted("settings.operational.edit") };
  }, { errorPrefix: "STAFF_READ", maxBytes: 1024 });
}

/** Reuses the reviewed per-key authority, CAS, locking and atomic settings audit.
 * Only this key enters the settings writer; only this key leaves in the response. */
export async function commandCanonicalDisplayNotice(session: VerifiedDurableSession, body: unknown): Promise<CanonicalDisplayNotice & { ok: true }> {
  const input = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (typeof input.on !== "boolean") throw new CanonicalSettingsRefusal("invalid_settings_request", 400, "القيمة المطلوبة: on صحيح أو خطأ.");
  if (!Object.prototype.hasOwnProperty.call(input, "version")) throw new CanonicalSettingsRefusal("setting_version_missing", 409, "حدّث حالة رسالة التأخير قبل تغييرها.");
  if (input.version !== null && (typeof input.version !== "string" || input.version.length > 64)) throw new CanonicalSettingsRefusal("invalid_settings_request", 400, "نسخة الإعداد غير صالحة.");
  const result = await commandCanonicalSettingsWrite(session, parseCanonicalSettingsUpdate({
    [KEY]: input.on ? "true" : "false", __versions: { [KEY]: input.version },
  }));
  return { ok: true, on: result[KEY] === "true", version: result.__versions[KEY] ?? null, canEdit: result.__canWrite.includes(KEY) };
}
