import { ensureSchema, getPool, insertAuditRow, type DbClient } from "./db";
import {
  canonicalPerioSites, changedPerioSites, checkPerioAddendum, checkPerioDraft, checkPerioRevision, samePerioDraft, summarizePerio,
  type PerioDraft, type PerioObservation, type PerioSite,
} from "./periodontics";

type Reader = Pick<DbClient, "query">;
interface Actor { actor: string; actorRole?: string | null }
export interface PerioAddendum { id: number; body: string; author: string; createdAt: string }
export interface PerioExamView extends PerioDraft {
  id: number; visitId: number; patientId: number; caseTitle: string | null; doctorName: string;
  revision: number; recordedBy: string; recordedAt: string; updatedBy: string | null; updatedAt: string | null;
  signedAt: string | null; signedBy: string | null; addenda: PerioAddendum[];
  summary: ReturnType<typeof summarizePerio>;
}
interface ExamRow {
  id: number; visit_id: number; patient_id: number; case_id: number | null; case_title: string | null;
  doctor_id: number; doctor_name: string; revision: number; recorded_by: string; recorded_at: Date;
  updated_by: string | null; updated_at: Date | null; signed_at: Date | null; signed_by: string | null;
}
interface SiteRow { id: number; exam_id: number; tooth_code: number; site: PerioSite; probing_depth_mm: string | null; bleeding_on_probing: boolean | null }
const EXAM_SELECT = `SELECT e.*, v.patient_id, v.signed_at, v.signed_by, c.title AS case_title, d.name AS doctor_name
  FROM perio_exams e JOIN visits v ON v.id = e.visit_id JOIN parties d ON d.id = e.doctor_id
  LEFT JOIN clinical_cases c ON c.id = e.case_id`;
const toSite = (row: SiteRow): PerioObservation => ({ toothCode: row.tooth_code, site: row.site,
  probingDepthMm: row.probing_depth_mm === null ? null : Number(row.probing_depth_mm), bleedingOnProbing: row.bleeding_on_probing });
async function loadExams(client: Reader, rows: ExamRow[]): Promise<PerioExamView[]> {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const { rows: sites } = await client.query<SiteRow>(`SELECT * FROM perio_site_observations WHERE exam_id = ANY($1::int[]) ORDER BY id`, [ids]);
  const { rows: addenda } = await client.query<{ id: number; exam_id: number; body: string; author: string; created_at: Date }>(
    `SELECT id, exam_id, body, author, created_at FROM perio_addenda WHERE exam_id = ANY($1::int[]) ORDER BY id`, [ids]);
  return rows.map((row) => {
    const observations = canonicalPerioSites(sites.filter((site) => site.exam_id === row.id).map(toSite));
    return { id: row.id, visitId: row.visit_id, patientId: row.patient_id, caseId: row.case_id, caseTitle: row.case_title,
      doctorId: row.doctor_id, doctorName: row.doctor_name, revision: row.revision,
      recordedBy: row.recorded_by, recordedAt: row.recorded_at.toISOString(), updatedBy: row.updated_by, updatedAt: row.updated_at?.toISOString() ?? null,
      signedAt: row.signed_at?.toISOString() ?? null, signedBy: row.signed_by, sites: observations, summary: summarizePerio(observations),
      addenda: addenda.filter((a) => a.exam_id === row.id).map((a) => ({ id: a.id, body: a.body, author: a.author, createdAt: a.created_at.toISOString() })) };
  });
}
async function oneExam(client: Reader, examId: number, patientId: number): Promise<PerioExamView> {
  const { rows } = await client.query<ExamRow>(`${EXAM_SELECT} WHERE e.id = $1 AND v.patient_id = $2`, [examId, patientId]);
  const [exam] = await loadExams(client, rows);
  if (!exam) throw new Error("periodontal exam disappeared from authorized patient");
  return exam;
}
/** Read one coherent snapshot, so revision and observations cannot come from different saves. */
export async function listPatientPerio(patientId: number): Promise<PerioExamView[]> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows } = await client.query<ExamRow>(`${EXAM_SELECT} WHERE v.patient_id = $1 ORDER BY e.recorded_at DESC, e.id DESC`, [patientId]);
    const exams = await loadExams(client, rows);
    await client.query("COMMIT");
    return exams;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
/** An empty header/all-null rows do not qualify. A recorded false BOP or zero PD does. */
export async function hasMeaningfulPerioVisit(client: Reader, visitId: number): Promise<boolean> {
  const { rows } = await client.query(`SELECT 1 FROM perio_exams e JOIN perio_site_observations s ON s.exam_id = e.id
    WHERE e.visit_id = $1 AND (s.probing_depth_mm IS NOT NULL OR s.bleeding_on_probing IS NOT NULL) LIMIT 1`, [visitId]);
  return rows.length > 0;
}
export type PerioRefusal = "not_found" | "visit_signed" | "bad_draft" | "bad_case" | "case_closed" | "bad_doctor" | "revision_conflict" | "not_signed" | "bad_addendum" | "idempotency_conflict";
export const PERIO_MESSAGE: Record<PerioRefusal, string> = {
  not_found: "الفحص أو الزيارة غير موجودة في ملف هذا المريض.", visit_signed: "الزيارة موقّعة. التصحيح يكون بملحق.",
  bad_draft: "بيانات فحص اللثة غير صالحة.", bad_case: "الحالة ليست حالة لثة لهذا المريض.", case_closed: "الحالة منتهية. اختر سياقًا سريريًا صالحًا دون إعادة فتحها.",
  bad_doctor: "اختر الطبيب المعالج الفعلي للفحص.", revision_conflict: "تغيّر فحص اللثة. أعد تحميل السجل قبل دمج تعديلاتك.",
  not_signed: "الزيارة غير موقّعة. عدّل الفحص بدل إضافة ملحق.", bad_addendum: "نص الملحق أو مفتاح إعادته غير صالح.",
  idempotency_conflict: "استُخدم مفتاح الملحق بمحتوى أو كاتب مختلف. أعد تحميل السجل.",
};
export type PerioResult = { ok: true; created: boolean; unchanged: boolean; exam: PerioExamView } | { ok: false; reason: PerioRefusal };

/** Patient KEY SHARE fence → visit UPDATE lock → exam; merges/deletions wait, non-key phone enrichment does not. */
export async function savePerioExam(input: Actor & { patientId: number; visitId: number; draft: PerioDraft; expectedRevision: number | null }): Promise<PerioResult> {
  const checked = checkPerioDraft(input.draft);
  const revision = checkPerioRevision(input.expectedRevision);
  if (!checked.ok || !revision.ok) return { ok: false, reason: "bad_draft" };
  const draft = checked.value;
  await ensureSchema();
  const client = await getPool().connect();
  const refuse = async (reason: PerioRefusal): Promise<PerioResult> => { await client.query("ROLLBACK"); return { ok: false, reason }; };
  try {
    await client.query("BEGIN");
    const { rows: patient } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR KEY SHARE`, [input.patientId]);
    if (!patient[0]) return await refuse("not_found");
    const { rows: visits } = await client.query<{ patient_id: number | null; signed_at: Date | null; case_id: number | null }>(
      `SELECT patient_id, signed_at, case_id FROM visits WHERE id = $1 FOR UPDATE`, [input.visitId]);
    const visit = visits[0];
    if (!visit || visit.patient_id !== input.patientId) return await refuse("not_found");
    if (visit.signed_at !== null) return await refuse("visit_signed");
    if (visit.case_id !== null && visit.case_id !== draft.caseId) return await refuse("bad_case");
    const { rows: existing } = await client.query<{ id: number; revision: number }>(`SELECT id, revision FROM perio_exams WHERE visit_id = $1 FOR UPDATE`, [input.visitId]);
    const current = existing[0] ? await oneExam(client, existing[0].id, input.patientId) : null;
    if (current && (input.expectedRevision === null || input.expectedRevision <= current.revision) && samePerioDraft(current, draft)) {
      await client.query("COMMIT");
      return { ok: true, created: false, unchanged: true, exam: current };
    }
    if (current ? input.expectedRevision !== current.revision : input.expectedRevision !== null) return await refuse("revision_conflict");
    const { rows: doctors } = await client.query(`SELECT id FROM parties WHERE id = $1 AND kind = 'doctor' FOR SHARE`, [draft.doctorId]);
    if (!doctors[0]) return await refuse("bad_doctor");
    if (draft.caseId !== null) {
      const { rows: cases } = await client.query<{ status: string }>(
        `SELECT status FROM clinical_cases WHERE id = $1 AND patient_id = $2 AND specialty = 'periodontics' FOR SHARE`, [draft.caseId, input.patientId]);
      if (!cases[0]) return await refuse("bad_case");
      if (!["active", "waiting"].includes(cases[0].status)) return await refuse("case_closed");
    }
    let examId: number;
    if (current) {
      examId = current.id;
      await client.query(`UPDATE perio_exams SET doctor_id = $2, case_id = $3, revision = revision + 1, updated_by = $4, updated_at = NOW() WHERE id = $1`,
        [examId, draft.doctorId, draft.caseId, input.actor]);
    } else {
      const { rows: [created] } = await client.query<{ id: number }>(
        `INSERT INTO perio_exams (visit_id, case_id, doctor_id, recorded_by) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.visitId, draft.caseId, draft.doctorId, input.actor]);
      examId = created.id;
    }
    // PUT is a complete explicit snapshot. No tooth-presence/category filtering occurs here.
    // Upsert preserves stable site IDs for all retained sites, including explicit null/zero/false.
    for (const site of draft.sites) await client.query(
      `INSERT INTO perio_site_observations (exam_id, tooth_code, site, probing_depth_mm, bleeding_on_probing) VALUES ($1, $2, $3, $4::numeric, $5)
       ON CONFLICT (exam_id, tooth_code, site) DO UPDATE SET probing_depth_mm = EXCLUDED.probing_depth_mm, bleeding_on_probing = EXCLUDED.bleeding_on_probing
       WHERE perio_site_observations.probing_depth_mm IS DISTINCT FROM EXCLUDED.probing_depth_mm
          OR perio_site_observations.bleeding_on_probing IS DISTINCT FROM EXCLUDED.bleeding_on_probing`,
      [examId, site.toothCode, site.site, site.probingDepthMm, site.bleedingOnProbing]);
    await client.query(`DELETE FROM perio_site_observations WHERE exam_id = $1 AND NOT ((tooth_code::text || ':' || site) = ANY($2::text[]))`,
      [examId, draft.sites.map((site) => `${site.toothCode}:${site.site}`)]);
    await insertAuditRow(client, { action: "perio.exam_save", entity: "patient", entityId: input.patientId,
      details: { examId, visitId: input.visitId,
        before: current ? { doctorId: current.doctorId, caseId: current.caseId, revision: current.revision } : null,
        after: { doctorId: draft.doctorId, caseId: draft.caseId, revision: (current?.revision ?? 0) + 1 },
        changedSites: changedPerioSites(current?.sites ?? [], draft.sites),
        ...summarizePerio(draft.sites) }, actor: input.actor, actorRole: input.actorRole ?? null });
    const exam = await oneExam(client, examId, input.patientId);
    await client.query("COMMIT");
    return { ok: true, created: !current, unchanged: false, exam };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
export async function addPerioAddendum(input: Actor & { patientId: number; examId: number; text: string; requestKey: string }): Promise<PerioResult> {
  const checked = checkPerioAddendum(input);
  if (!checked.ok) return { ok: false, reason: "bad_addendum" };
  await ensureSchema();
  const client = await getPool().connect();
  const refuse = async (reason: PerioRefusal): Promise<PerioResult> => { await client.query("ROLLBACK"); return { ok: false, reason }; };
  try {
    await client.query("BEGIN");
    const { rows: patient } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR KEY SHARE`, [input.patientId]);
    if (!patient[0]) return await refuse("not_found");
    const { rows: visits } = await client.query<{ id: number; patient_id: number | null; signed_at: Date | null }>(
      `SELECT v.id, v.patient_id, v.signed_at FROM visits v JOIN perio_exams e ON e.visit_id = v.id WHERE e.id = $1 FOR UPDATE OF v`, [input.examId]);
    const visit = visits[0];
    if (!visit || visit.patient_id !== input.patientId) return await refuse("not_found");
    if (visit.signed_at === null) return await refuse("not_signed");
    const { rows: prior } = await client.query<{ body: string; author: string }>(`SELECT body, author FROM perio_addenda WHERE exam_id = $1 AND request_key = $2`, [input.examId, checked.value.requestKey]);
    if (prior[0] && (prior[0].body !== checked.value.text || prior[0].author !== input.actor)) return await refuse("idempotency_conflict");
    if (!prior[0]) {
      const { rows: [added] } = await client.query<{ id: number }>(
        `INSERT INTO perio_addenda (exam_id, request_key, body, author) VALUES ($1, $2, $3, $4) RETURNING id`,
        [input.examId, checked.value.requestKey, checked.value.text, input.actor]);
      await insertAuditRow(client, { action: "perio.addendum", entity: "patient", entityId: input.patientId,
        details: { examId: input.examId, visitId: visit.id, addendumId: added.id }, actor: input.actor, actorRole: input.actorRole ?? null });
    }
    const exam = await oneExam(client, input.examId, input.patientId);
    await client.query("COMMIT");
    return { ok: true, created: !prior[0], unchanged: !!prior[0], exam };
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}
