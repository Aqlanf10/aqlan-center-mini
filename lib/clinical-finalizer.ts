/**
 * (P0-F) حدود المساعد السريري في حفظ الزيارة — منطقٌ خالص.
 *
 * المساعد يُكمل الملاحظات ويُنهي الزيارة باسمه، أما الإجراءات وأسعارها وأطباؤها فملك الطبيب:
 * أي اختلافٍ بين ما يرسله المساعد وما هو محفوظ رفضٌ صريح — لا تجاهلٌ صامت ولا قبولٌ جزئي.
 */
interface SavedLine {
  serviceId: number;
  toothCode: number | null;
  surfaces: string | null;
  quantity: number;
  unitPriceMinor: number;
  doctorId: number | null;
  planItemId: number | null;
}

function normalizeSaved(line: SavedLine): string {
  return JSON.stringify([
    line.serviceId, line.toothCode ?? null, (line.surfaces ?? "").trim() || null, line.quantity,
    line.unitPriceMinor, line.doctorId ?? null, line.planItemId ?? null,
  ]);
}

function normalizeRequested(raw: unknown): string | null {
  const row = (raw ?? {}) as Record<string, unknown>;
  const serviceId = Number(row.serviceId);
  if (!(serviceId > 0)) return null;
  const surfaces = typeof row.surfaces === "string" && row.surfaces.trim() ? row.surfaces.trim() : null;
  return JSON.stringify([
    serviceId, Number(row.toothCode) || null, surfaces, Math.max(1, Math.round(Number(row.quantity) || 1)),
    Math.max(0, Math.round(Number(row.unitPriceMinor) || 0)), Number(row.doctorId) || null,
    Number(row.planItemId) > 0 ? Number(row.planItemId) : null,
  ]);
}

/** هل يغيّر طلب المساعد إجراءات الزيارة (إضافةً أو حذفًا أو سعرًا أو طبيبًا أو ربطًا)؟ */
export function assistantProcedureChange(saved: readonly SavedLine[], requested: readonly unknown[]): boolean {
  const want = requested.map(normalizeRequested).filter((line): line is string => line !== null).sort();
  const have = saved.map(normalizeSaved).sort();
  if (want.length !== have.length) return true;
  return want.some((line, index) => line !== have[index]);
}
