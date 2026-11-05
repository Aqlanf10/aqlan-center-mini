/** Shared, fail-closed parser for the centrally managed imaging destinations. */
export const RADIOLOGY_CENTERS_KEY = "clinical.radiology_centers" as const;
export const MAX_RADIOLOGY_CENTERS = 100;
export const MAX_RADIOLOGY_CENTERS_BYTES = 256_000;
export interface RadiologyCenter { id: string; name: string; address: string; active: boolean; }
export type RadiologyCentersResult = { ok: true; centers: RadiologyCenter[] } | { ok: false; message: string };
export const RADIOLOGY_CENTER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
// Includes bidi overrides/isolation and invisible control characters; ordinary Arabic is allowed.
// eslint-disable-next-line no-control-regex -- Explicit rejection of unsafe stored display controls.
const CONTROLS = /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/;
export function parseRadiologyCenters(raw: string): RadiologyCentersResult {
  const fail = (message: string): RadiologyCentersResult => ({ ok: false, message });
  if (typeof raw !== "string" || raw.length > MAX_RADIOLOGY_CENTERS_BYTES || new TextEncoder().encode(raw).length > MAX_RADIOLOGY_CENTERS_BYTES) return fail("قائمة مراكز الأشعة أكبر من الحد المسموح.");
  let source: unknown;
  try { source = JSON.parse(raw); } catch { return fail("قائمة مراكز الأشعة غير صالحة."); }
  if (!Array.isArray(source) || source.length > MAX_RADIOLOGY_CENTERS) return fail("قائمة مراكز الأشعة يجب ألا تتجاوز ١٠٠ مركز.");
  const ids = new Set<string>();
  const centers: RadiologyCenter[] = [];
  for (const item of source) {
    if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some(key => !["id", "name", "address", "active"].includes(key))) return fail("بيانات مركز الأشعة غير صالحة.");
    const { id, name, address, active } = item;
    if (typeof id !== "string" || !RADIOLOGY_CENTER_UUID.test(id) || ids.has(id)) return fail("معرّف مركز الأشعة غير صالح أو مكرر.");
    if (typeof name !== "string" || !name.trim() || name.length > 160 || CONTROLS.test(name)) return fail("اسم مركز الأشعة مطلوب، بحد أقصى ١٦٠ حرفًا ودون محارف تحكم.");
    if (typeof address !== "string" || !address.trim() || address.length > 400 || CONTROLS.test(address)) return fail("عنوان مركز الأشعة مطلوب، بحد أقصى ٤٠٠ حرف ودون محارف تحكم.");
    if (typeof active !== "boolean") return fail("حالة مركز الأشعة يجب أن تكون مفعّلًا أو معطّلًا.");
    ids.add(id); centers.push({ id, name: name.trim(), address: address.trim(), active });
  }
  return { ok: true, centers };
}
