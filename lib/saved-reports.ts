import { ensureSchema, getPool } from "./db";
import { isKnownUnifiedReport, type UnifiedReportId } from "./report-access";

export const REPORT_SECTION_IDS = ["operational", "financial", "receivables", "clinical", "doctors"] as const;
export type ReportSectionId = typeof REPORT_SECTION_IDS[number];

const REPORT_QUERY_KEYS = [
  "report", "preset", "from", "to", "specialty", "doctorId", "patientId", "serviceId",
  "currency", "patientStatus", "debtStatus", "debtMode", "compare", "method", "receivedBy",
  // (Reports R3) العرض المخصّص: الأعمدة بترتيبها، ترتيب الصفوف، التجميع.
  "columns", "sort", "group",
] as const;

export interface SavedReport {
  id: number;
  name: string;
  reportId: UnifiedReportId;
  sectionId: ReportSectionId;
  queryString: string;
  isFavorite: boolean;
  /** قالبٌ مشترك يراه الطاقم (ينشئه المدير) — يُعرض لكلٍّ حسب صلاحيته على التقرير. */
  isShared: boolean;
  /** هل المستخدم الحالي مالكه — وحده يعدّله أو يحذفه. */
  owned: boolean;
  ownerUsername: string;
  createdAt: string;
  updatedAt: string;
}

export class SavedReportInputError extends Error {}

export function normalizeSavedReportName(value: unknown): string {
  const name = String(value ?? "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) {
    throw new SavedReportInputError("اسم التقرير يجب أن يكون بين ١ و٨٠ حرفًا.");
  }
  return name;
}

export function normalizeReportSection(value: unknown): ReportSectionId {
  const section = String(value ?? "");
  if (!(REPORT_SECTION_IDS as readonly string[]).includes(section)) {
    throw new SavedReportInputError("قسم التقرير غير صالح.");
  }
  return section as ReportSectionId;
}

export function normalizeSavedReportQuery(reportIdRaw: unknown, rawQuery: unknown): {
  reportId: UnifiedReportId;
  queryString: string;
} {
  const reportId = String(reportIdRaw ?? "");
  if (!isKnownUnifiedReport(reportId)) {
    throw new SavedReportInputError("نوع التقرير غير صالح.");
  }
  if (reportId === "options") {
    throw new SavedReportInputError("نوع التقرير غير صالح.");
  }
  const savedReportId: UnifiedReportId = reportId;

  const source = String(rawQuery ?? "").replace(/^\?/, "");
  if (!source || source.length > 4096) throw new SavedReportInputError("رابط التقرير غير صالح.");

  const input = new URLSearchParams(source);
  if (input.get("report") && input.get("report") !== reportId) {
    throw new SavedReportInputError("نوع التقرير لا يطابق الرابط المحفوظ.");
  }

  const output = new URLSearchParams();
  output.set("report", savedReportId);
  for (const key of REPORT_QUERY_KEYS) {
    if (key === "report") continue;
    const value = input.get(key);
    if (value !== null && value !== "") output.set(key, value.slice(0, 256));
  }
  return { reportId: savedReportId, queryString: output.toString() };
}

type SavedRow = {
  id: number; name: string; report_id: string; section_id: string; query_string: string;
  is_favorite: boolean; is_shared: boolean; owner_username: string;
  created_at: Date | string; updated_at: Date | string;
};

const SAVED_COLUMNS = `id, name, report_id, section_id, query_string, is_favorite, is_shared, owner_username,
  created_at, updated_at`;

function mapRow(row: SavedRow, viewer: string): SavedReport {
  return {
    id: row.id,
    name: row.name,
    reportId: row.report_id as UnifiedReportId,
    sectionId: row.section_id as ReportSectionId,
    queryString: row.query_string,
    isFavorite: row.owner_username === viewer && row.is_favorite,
    isShared: row.is_shared,
    owned: row.owner_username === viewer,
    ownerUsername: row.owner_username,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

function uniqueViolation(error: unknown): never {
  const code = (error as { code?: string })?.code;
  if (code === "23505") throw new SavedReportInputError("لديك تقرير محفوظ بهذا الاسم.");
  throw error;
}

/**
 * تقارير المستخدم نفسه + القوالب المشتركة من غيره. تصفية الصلاحية على نوع التقرير
 * تتم في المسار (canAccessUnifiedReport) — القالب المشترك لا يمنح صلاحيةً لا يملكها المستخدم.
 */
export async function listSavedReports(viewerUsername: string): Promise<SavedReport[]> {
  await ensureSchema();
  const { rows } = await getPool().query<SavedRow>(
    `SELECT ${SAVED_COLUMNS}
       FROM saved_reports
      WHERE owner_username = $1 OR is_shared
      ORDER BY (owner_username = $1 AND is_favorite) DESC, is_shared DESC, updated_at DESC, id DESC`,
    [viewerUsername],
  );
  return rows.map((row) => mapRow(row, viewerUsername));
}

/** تقريرٌ محفوظ يراه المستخدم: ملكه أو قالبٌ مشترك. */
export async function getVisibleSavedReport(viewerUsername: string, id: number): Promise<SavedReport | null> {
  await ensureSchema();
  const { rows } = await getPool().query<SavedRow>(
    `SELECT ${SAVED_COLUMNS} FROM saved_reports WHERE id = $1 AND (owner_username = $2 OR is_shared)`,
    [id, viewerUsername],
  );
  return rows[0] ? mapRow(rows[0], viewerUsername) : null;
}

export async function createSavedReport(input: {
  ownerUsername: string;
  name: string;
  reportId: UnifiedReportId;
  sectionId: ReportSectionId;
  queryString: string;
  isFavorite?: boolean;
  isShared?: boolean;
}): Promise<SavedReport> {
  await ensureSchema();
  try {
    const { rows } = await getPool().query<SavedRow>(
      `INSERT INTO saved_reports (owner_username, name, report_id, section_id, query_string, is_favorite, is_shared)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING ${SAVED_COLUMNS}`,
      [input.ownerUsername, input.name, input.reportId, input.sectionId, input.queryString,
        Boolean(input.isFavorite), Boolean(input.isShared)],
    );
    return mapRow(rows[0], input.ownerUsername);
  } catch (error) {
    return uniqueViolation(error);
  }
}

/** تعديل المالك وحده: الاسم، المفضلة، المشاركة (المسار يقصرها على المدير)، أو حفظ العرض الحالي فوقه. */
export async function updateSavedReport(input: {
  ownerUsername: string;
  id: number;
  name?: string;
  isFavorite?: boolean;
  isShared?: boolean;
  view?: { reportId: UnifiedReportId; sectionId: ReportSectionId; queryString: string };
}): Promise<SavedReport | null> {
  await ensureSchema();
  const name = input.name === undefined ? null : normalizeSavedReportName(input.name);
  try {
    const { rows } = await getPool().query<SavedRow>(
      `UPDATE saved_reports
          SET name = COALESCE($3::text, name),
              is_favorite = COALESCE($4::boolean, is_favorite),
              is_shared = COALESCE($5::boolean, is_shared),
              report_id = COALESCE($6::text, report_id),
              section_id = COALESCE($7::text, section_id),
              query_string = COALESCE($8::text, query_string),
              updated_at = NOW()
        WHERE id = $1 AND owner_username = $2
        RETURNING ${SAVED_COLUMNS}`,
      [input.id, input.ownerUsername, name, input.isFavorite ?? null, input.isShared ?? null,
        input.view?.reportId ?? null, input.view?.sectionId ?? null, input.view?.queryString ?? null],
    );
    return rows[0] ? mapRow(rows[0], input.ownerUsername) : null;
  } catch (error) {
    return uniqueViolation(error);
  }
}

/** اسمٌ متاح للنسخة: «نسخة من X»، ثم «نسخة من X (2)»… ضمن حد الثمانين حرفًا. */
export async function availableCopyName(ownerUsername: string, sourceName: string): Promise<string> {
  const { rows } = await getPool().query<{ name: string }>(
    `SELECT lower(name) AS name FROM saved_reports WHERE owner_username = $1`,
    [ownerUsername],
  );
  const taken = new Set(rows.map((row) => row.name));
  const stem = `نسخة من ${sourceName}`.slice(0, 72);
  if (!taken.has(stem.toLowerCase())) return stem;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${stem} (${index})`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
  throw new SavedReportInputError("تعذّر اختيار اسم للنسخة؛ سمّها يدويًّا.");
}

export async function deleteSavedReport(ownerUsername: string, id: number): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query(
    "DELETE FROM saved_reports WHERE id = $1 AND owner_username = $2",
    [id, ownerUsername],
  );
  return (result.rowCount ?? 0) > 0;
}
