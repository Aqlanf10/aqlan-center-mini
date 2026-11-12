import { ensureSchema, getPool, insertAuditRow, CLINIC_TIME_ZONE, type DbClient, type DbPool } from "./db";
import {
  caseParticipationProblem, type CaseParticipant, type CaseParticipation, type CaseParticipationProblem, type CaseParticipationResolver,
} from "./commission";
import { loadCaseParticipationsAt } from "./commission-participation-read";

/**
 * Doctors sharing a case: storing and reading the centre's decision (owner decision 2026-11-11,
 * finance point 3, option 2, per case). Append-only: each decision supersedes the head of the
 * case's chain, in one transaction with its audit row, under the case row lock. Nothing recorded
 * earlier is changed: a later decision changes each participant's cumulative commission, and the
 * next payroll run settles the difference (approved and closed runs are never rewritten).
 */
export type CaseParticipationStatus = "approved" | "pending" | "void";
export type CaseParticipationSource = "centre_decision" | "sessions_guided" | "equal";
export const CASE_PARTICIPATION_SOURCES: readonly CaseParticipationSource[] = ["centre_decision", "sessions_guided", "equal"];

export interface CaseParticipationRecord {
  id: number; caseId: number; status: CaseParticipationStatus; participants: CaseParticipant[];
  source: CaseParticipationSource; reason: string; supersedesId: number | null;
  decidedBy: string; decidedByUserId: number | null; decidedAt: string; isHead: boolean;
}
export interface DecideCaseParticipationInput {
  caseId: number; status: CaseParticipationStatus; participants: readonly CaseParticipant[];
  source: CaseParticipationSource; reason: string;
  /** The head the decision was made against (`null` = the case has no decision yet); a stale head is refused. */
  expectedHeadId: number | null;
  actor: { username: string; userId: number | null; role: string | null };
}
export type DecideCaseParticipationRefusal =
  | "invalid_case" | "case_not_found" | "invalid_source" | "reason_required" | "stale_head" | "nothing_to_void" | "participants_not_allowed"
  | "doctor_not_found" | CaseParticipationProblem;
export type DecideCaseParticipationResult = { ok: true; record: CaseParticipationRecord } | { ok: false; reason: DecideCaseParticipationRefusal };

export const CASE_PARTICIPATION_MESSAGE: Record<DecideCaseParticipationRefusal, string> = {
  invalid_case: "رقم الحالة غير صالح.",
  case_not_found: "الحالة غير موجودة.",
  invalid_source: "حدّد مصدر قرار التوزيع: قرار المركز، أو استرشاد بعدد الجلسات، أو تقسيم متساوٍ.",
  reason_required: "اكتب سبب قرار توزيع المشاركة.",
  stale_head: "تغيّر قرار مشاركة هذه الحالة منذ فتحه؛ أعد تحميله ثم راجع قرارك.",
  nothing_to_void: "لا يوجد قرار مشاركة ساري لهذه الحالة لإلغائه.",
  participants_not_allowed: "قرار التعليق أو الإلغاء لا يحمل نسبًا.",
  doctor_not_found: "أحد المشاركين ليس طبيبًا مسجّلًا في المركز.",
  no_participants: "أضف طبيبًا مشاركًا واحدًا على الأقل.",
  duplicate_doctor: "لا يتكرر الطبيب نفسه في قرار المشاركة.",
  invalid_doctor: "هوية طبيب مشارك غير صالحة.",
  invalid_share: "نسبة كل مشارك عدد صحيح موجب من نقاط الأساس (100٪ = 10000).",
  shares_below_full: "مجموع نسب المشاركين أقل من 100٪؛ تبقى العمولة معلّقة حتى يكتمل التوزيع.",
  shares_above_full: "مجموع نسب المشاركين يتجاوز 100٪.",
};

type Row = { id: string; case_id: number; status: CaseParticipationStatus; participants: CaseParticipant[]; source: CaseParticipationSource;
  reason: string; supersedes_id: string | null; decided_by: string; decided_by_user_id: number | null; decided_at: Date; is_head: boolean };
const COLUMNS = `p.id, p.case_id, p.status, p.participants, p.source, p.reason, p.supersedes_id, p.decided_by, p.decided_by_user_id, p.decided_at,
  NOT EXISTS (SELECT 1 FROM commission_case_participations n WHERE n.supersedes_id = p.id) AS is_head`;
const toRecord = (row: Row): CaseParticipationRecord => ({
  id: Number(row.id), caseId: row.case_id, status: row.status, participants: row.participants, source: row.source, reason: row.reason,
  supersedesId: row.supersedes_id === null ? null : Number(row.supersedes_id), decidedBy: row.decided_by, decidedByUserId: row.decided_by_user_id,
  decidedAt: row.decided_at.toISOString(), isHead: row.is_head,
});

/** Every decision of a case, oldest first (the last one is the head). */
export async function listCaseParticipationHistory(caseId: number, runner: DbClient | DbPool = getPool()): Promise<CaseParticipationRecord[]> {
  if (runner === getPool()) await ensureSchema();
  const { rows } = await runner.query<Row>(`SELECT ${COLUMNS} FROM commission_case_participations p WHERE p.case_id = $1 ORDER BY p.id`, [caseId]);
  return rows.map(toRecord);
}

/** The decisions in force at the end of a clinic day, by case (see `loadCaseParticipationsAt`). */
export const loadCaseParticipations = (asOfClinicDate: string, runner: DbClient | DbPool): Promise<Map<number, CaseParticipation>> =>
  loadCaseParticipationsAt(asOfClinicDate, runner as Parameters<typeof loadCaseParticipationsAt>[1], CLINIC_TIME_ZONE);
export const caseParticipationResolver = (byCase: ReadonlyMap<number, CaseParticipation>): CaseParticipationResolver => caseId => byCase.get(caseId);

/** Records one decision. The case row lock orders concurrent decisions; the unique index on
 * `supersedes_id` is the safety net. The audit row is written in the same transaction. */
export async function decideCaseParticipation(input: DecideCaseParticipationInput): Promise<DecideCaseParticipationResult> {
  if (!Number.isSafeInteger(input.caseId) || input.caseId <= 0) return { ok: false, reason: "invalid_case" };
  if (!CASE_PARTICIPATION_SOURCES.includes(input.source)) return { ok: false, reason: "invalid_source" };
  const reason = typeof input.reason === "string" ? input.reason.trim().slice(0, 500) : "";
  if (reason.length < 3) return { ok: false, reason: "reason_required" };
  const participants = input.participants.map(part => ({ doctorId: part.doctorId, shareBp: part.shareBp }));
  if (input.status === "approved") {
    const problem = caseParticipationProblem(participants);
    if (problem) return { ok: false, reason: problem };
  } else if (participants.length > 0) return { ok: false, reason: "participants_not_allowed" };

  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const refuse = async (refusal: DecideCaseParticipationRefusal): Promise<DecideCaseParticipationResult> => { await client.query("ROLLBACK"); return { ok: false, reason: refusal }; };
    const { rows: [target] } = await client.query<{ id: number; patient_id: number; title: string | null }>(
      "SELECT id, patient_id, title FROM clinical_cases WHERE id = $1 FOR UPDATE", [input.caseId]);
    if (!target) return refuse("case_not_found");
    const { rows: [head] } = await client.query<{ id: string; status: CaseParticipationStatus }>(
      `SELECT p.id, p.status FROM commission_case_participations p
        WHERE p.case_id = $1 AND NOT EXISTS (SELECT 1 FROM commission_case_participations n WHERE n.supersedes_id = p.id)`, [input.caseId]);
    const headId = head ? Number(head.id) : null;
    if (headId !== input.expectedHeadId) return refuse("stale_head");
    if (input.status === "void" && (!head || head.status === "void")) return refuse("nothing_to_void");
    if (participants.length > 0) {
      const { rows: doctors } = await client.query<{ id: number }>(
        "SELECT id FROM parties WHERE id = ANY($1::int[]) AND kind = 'doctor' ORDER BY id FOR SHARE", [participants.map(part => part.doctorId)]);
      if (doctors.length !== participants.length) return refuse("doctor_not_found");
    }
    const { rows: [inserted] } = await client.query<{ id: string }>(
      `INSERT INTO commission_case_participations (case_id, status, participants, source, reason, supersedes_id, decided_by, decided_by_user_id)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8) RETURNING id`,
      [input.caseId, input.status, JSON.stringify(participants), input.source, reason, headId, input.actor.username, input.actor.userId]);
    await insertAuditRow(client, {
      action: input.status === "void" ? "commission.case_participation.void" : "commission.case_participation.set",
      entity: "clinical_case", entityId: input.caseId, entityLabel: target.title ?? `حالة #${input.caseId}`,
      actor: input.actor.username, actorRole: input.actor.role,
      details: { participationId: Number(inserted.id), supersedesId: headId, patientId: target.patient_id, status: input.status, participants, source: input.source, reason },
    });
    const { rows: [row] } = await client.query<Row>(`SELECT ${COLUMNS} FROM commission_case_participations p WHERE p.id = $1`, [inserted.id]);
    await client.query("COMMIT");
    return { ok: true, record: toRecord(row) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    // Two decisions on the same head: the unique index refused the second one.
    if ((error as { code?: string } | null)?.code === "23505") return { ok: false, reason: "stale_head" };
    throw error;
  } finally { client.release(); }
}
