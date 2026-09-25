import { ensureSchema, getPool } from "./db";
import { isKnownUnifiedReport, type UnifiedReportId } from "./report-access";

export const REPORT_SECTION_IDS = ["operational", "financial", "receivables", "clinical", "doctors"] as const;
export type ReportSectionId = typeof REPORT_SECTION_IDS[number];

const REPORT_QUERY_KEYS = [
  "report", "preset", "from", "to", "specialty", "doctorId", "patientId", "serviceId",
  "currency", "patientStatus", "debtStatus", "debtMode", "compare", "method", "receivedBy", "columns",
] as const;

export interface SavedReport {
  id: number;
  name: string;
  reportId: UnifiedReportId;
  sectionId: ReportSectionId;
  queryString: string;
  isFavorite: boolean;
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
  if (reportId === "options" || !isKnownUnifiedReport(reportId)) {
    throw new SavedReportInputError("نوع التقرير غير صالح.");
  }

  const source = String(rawQuery ?? "").replace(/^\?/, "");
  if (!source || source.length > 4096) throw new SavedReportInputError("رابط التقرير غير صالح.");

  const input = new URLSearchParams(source);
  if (input.get("report") && input.get("report") !== reportId) {
    throw new SavedReportInputError("نوع التقرير لا يطابق الرابط المحفوظ.");
  }

  const output = new URLSearchParams();
  output.set("report", reportId);
  for (const key of REPORT_QUERY_KEYS) {
    if (key === "report") continue;
    const value = input.get(key);
    if (value !== null && value !== "") output.set(key, value.slice(0, 256));
  }
  return { reportId, queryString: output.toString() };
}

function mapRow(row: {
  id: number; name: string; report_id: string; section_id: string; query_string: string;
  is_favorite: boolean; created_at: Date | string; updated_at: Date | string;
}): SavedReport {
  return {
    id: row.id,
    name: row.name,
    reportId: row.report_id as UnifiedReportId,
    sectionId: row.section_id as ReportSectionId,
    queryString: row.query_string,
    isFavorite: row.is_favorite,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listSavedReports(ownerUsername: string): Promise<SavedReport[]> {
  await ensureSchema();
  const { rows } = await getPool().query<{
    id: number; name: string; report_id: string; section_id: string; query_string: string;
    is_favorite: boolean; created_at: Date | string; updated_at: Date | string;
  }>(
    `SELECT id, name, report_id, section_id, query_string, is_favorite, created_at, updated_at
       FROM saved_reports
      WHERE owner_username = $1
      ORDER BY is_favorite DESC, updated_at DESC, id DESC`,
    [ownerUsername],
  );
  return rows.map(mapRow);
}

export async function createSavedReport(input: {
  ownerUsername: string;
  name: string;
  reportId: UnifiedReportId;
  sectionId: ReportSectionId;
  queryString: string;
  isFavorite?: boolean;
}): Promise<SavedReport> {
  await ensureSchema();
  try {
    const { rows } = await getPool().query<{
      id: number; name: string; report_id: string; section_id: string; query_string: string;
      is_favorite: boolean; created_at: Date | string; updated_at: Date | string;
    }>(
      `INSERT INTO saved_reports (owner_username, name, report_id, section_id, query_string, is_favorite)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, report_id, section_id, query_string, is_favorite, created_at, updated_at`,
      [input.ownerUsername, input.name, input.reportId, input.sectionId, input.queryString, Boolean(input.isFavorite)],
    );
    return mapRow(rows[0]);
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "23505") throw new SavedReportInputError("لديك تقرير محفوظ بهذا الاسم.");
    throw error;
  }
}

export async function updateSavedReport(input: {
  ownerUsername: string;
  id: number;
  name?: string;
  isFavorite?: boolean;
}): Promise<SavedReport | null> {
  await ensureSchema();
  const name = input.name === undefined ? null : normalizeSavedReportName(input.name);
  try {
    const { rows } = await getPool().query<{
      id: number; name: string; report_id: string; section_id: string; query_string: string;
      is_favorite: boolean; created_at: Date | string; updated_at: Date | string;
    }>(
      `UPDATE saved_reports
          SET name = COALESCE($3::text, name),
              is_favorite = COALESCE($4::boolean, is_favorite),
              updated_at = NOW()
        WHERE id = $1 AND owner_username = $2
        RETURNING id, name, report_id, section_id, query_string, is_favorite, created_at, updated_at`,
      [input.id, input.ownerUsername, name, input.isFavorite ?? null],
    );
    return rows[0] ? mapRow(rows[0]) : null;
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "23505") throw new SavedReportInputError("لديك تقرير محفوظ بهذا الاسم.");
    throw error;
  }
}

export async function deleteSavedReport(ownerUsername: string, id: number): Promise<boolean> {
  await ensureSchema();
  const result = await getPool().query(
    "DELETE FROM saved_reports WHERE id = $1 AND owner_username = $2",
    [id, ownerUsername],
  );
  return (result.rowCount ?? 0) > 0;
}
