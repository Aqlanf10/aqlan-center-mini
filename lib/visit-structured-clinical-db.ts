import { ensureSchema, getPool } from "./db";
import { readStructuredClinical, unavailableStructuredClinical, type VisitEndoReference, type VisitPerioReference, type VisitStructuredClinical } from "./visit-structured-clinical";

type Stored<T> = Omit<T, "recordedAt" | "updatedAt"> & { recordedAt: Date; updatedAt: Date | null };
const dates = <T extends { recordedAt: Date; updatedAt: Date | null }>(row: T) =>
  ({ ...row, recordedAt: row.recordedAt.toISOString(), updatedAt: row.updatedAt?.toISOString() ?? null });

/** Caller must authorize this patient first. Every query also fences the exact visit/patient. */
export async function getVisitStructuredClinical(visitId: number, patientId: number): Promise<VisitStructuredClinical> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [visit] } = await client.query<{
      signed_at: Date | null; signed_by: string | null; case_id: number | null;
      case_context_valid: boolean; endo_count: number; perio_count: number;
    }>(`SELECT signed_at, signed_by, case_id,
        (SELECT COUNT(*)::int FROM endo_visits WHERE visit_id = visits.id) AS endo_count,
        (SELECT COUNT(*)::int FROM perio_exams WHERE visit_id = visits.id) AS perio_count,
        (case_id IS NULL OR EXISTS (SELECT 1 FROM clinical_cases
          WHERE id = visits.case_id AND patient_id = visits.patient_id)) AS case_context_valid
      FROM visits WHERE id = $1 AND patient_id = $2`, [visitId, patientId]);
    if (!visit) throw new Error("Structured review visit is no longer in the authorized patient");
    if (visit.case_context_valid !== true) {
      await client.query("COMMIT");
      return unavailableStructuredClinical(visitId, patientId);
    }
    const { rows: endodontics } = await client.query<Stored<VisitEndoReference>>(`
      SELECT ev.id, ev.visit_id AS "visitId", v.patient_id AS "patientId", ev.treatment_id AS "treatmentId",
        t.case_id AS "caseId", t.tooth_code AS "toothCode", ev.doctor_id AS "doctorId", d.name AS "doctorName",
        ev.recorded_at AS "recordedAt", ev.updated_at AS "updatedAt", ev.version, ev.stage,
        counts."canalCount", counts."measuredCanalCount", counts."obturatedCanalCount"
      FROM endo_visits ev JOIN visits v ON v.id = ev.visit_id
      JOIN endo_treatments t ON t.id = ev.treatment_id AND t.patient_id = v.patient_id
      JOIN clinical_cases c ON c.id = t.case_id AND c.patient_id = v.patient_id
      LEFT JOIN parties d ON d.id = ev.doctor_id
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS "canalCount",
          COUNT(*) FILTER (WHERE working_length_mm IS NOT NULL)::int AS "measuredCanalCount",
          COUNT(*) FILTER (WHERE obturated IS TRUE)::int AS "obturatedCanalCount"
        FROM endo_canal_records WHERE endo_visit_id = ev.id
      ) counts
      WHERE ev.visit_id = $1 AND v.patient_id = $2 ORDER BY ev.id`, [visitId, patientId]);
    const { rows: periodontics } = await client.query<Stored<VisitPerioReference>>(`
      SELECT e.id, e.visit_id AS "visitId", v.patient_id AS "patientId", e.case_id AS "caseId",
        e.doctor_id AS "doctorId", d.name AS "doctorName", e.recorded_at AS "recordedAt", e.updated_at AS "updatedAt", e.revision,
        counts."siteCount", counts."toothCount", counts."recordedDepthSites", counts."recordedBleedingSites"
      FROM perio_exams e JOIN visits v ON v.id = e.visit_id
      LEFT JOIN clinical_cases c ON c.id = e.case_id AND c.patient_id = v.patient_id
      LEFT JOIN parties d ON d.id = e.doctor_id
      CROSS JOIN LATERAL (
        SELECT COUNT(*)::int AS "siteCount", COUNT(DISTINCT tooth_code)::int AS "toothCount",
          COUNT(*) FILTER (WHERE probing_depth_mm IS NOT NULL)::int AS "recordedDepthSites",
          COUNT(*) FILTER (WHERE bleeding_on_probing IS NOT NULL)::int AS "recordedBleedingSites"
        FROM perio_site_observations WHERE exam_id = e.id
      ) counts
      WHERE e.visit_id = $1 AND v.patient_id = $2 AND (e.case_id IS NULL OR c.id IS NOT NULL)
      ORDER BY e.id`, [visitId, patientId]);
    // A legacy ownership inconsistency may be filtered out by the patient joins.
    // Its existence makes the snapshot unverifiable; never hide it as ready-empty.
    const projection = endodontics.length !== visit.endo_count || periodontics.length !== visit.perio_count
      ? unavailableStructuredClinical(visitId, patientId)
      : readStructuredClinical({ status: "ready", visitId, patientId, visitCaseId: visit.case_id,
        signedAt: visit.signed_at?.toISOString() ?? null, signedBy: visit.signed_by,
        endodontics: endodontics.map(dates), periodontics: periodontics.map(dates) }, visitId, patientId);
    await client.query("COMMIT");
    return projection;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally { client.release(); }
}
