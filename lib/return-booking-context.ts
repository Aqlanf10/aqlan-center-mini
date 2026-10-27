import { readResponsibilityRevision } from "./responsibility-revision";
import { createHash } from "node:crypto";
import type { DbClient } from "./db";
import { parseReturnBookingSource, type ReturnBookingSource } from "./return-booking-source";
export { parseReturnBookingSource, type ReturnBookingSource } from "./return-booking-source";
type Runner = Pick<DbClient, "query">;
type Row = Record<string, any> & { id: number | string };
export interface ReturnBookingChoice {
  source: ReturnBookingSource; label: string; clinicalCaseId: number | null; orthoCaseId: number | null;
  doctorId: number | null; doctorName: string | null; available: boolean;
  settingsTarget: { kind: "clinical" | "ortho"; id: number }; code?: string; message?: string;
}
export type ReturnBookingResolution =
  | { ok: true; patientId: number; source: ReturnBookingSource; clinicalCaseId: number | null; orthoCaseId: number | null;
      doctorId: number; doctorName: string; fingerprint: string; label: string; settingsTarget: ReturnBookingChoice["settingsTarget"] }
  | { ok: false; code: string; message: string; contexts?: ReturnBookingChoice[] };
const refusal = (code: string, message: string): ReturnBookingResolution => ({ ok: false, code, message });
const missing = () => refusal("return_source_missing", "اختر الحالة أو العمل المرتبط بهذا الموعد؛ لم يُتحقق من مصدر سريري محدد.");
const changed = () => refusal("return_source_changed", "تغيّر مصدر الموعد أو الطبيب المسؤول. حدّث السياق وأعد المحاولة.");
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const validId = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const canonical = (value: ReturnBookingSource) => `${value.kind}:${value.id}`;

interface Facts { values: unknown[]; locks: Map<string, Set<string>>; cases: ReturnBookingSource[]; invalid: boolean }
function facts(): Facts { return { values: [], locks: new Map(), cases: [], invalid: false }; }
async function read(client: Runner, f: Facts, table: string, sql: string, args: unknown[]): Promise<Row[]> {
  const { rows } = await client.query<Row>(sql, args);
  f.values.push([table, rows]);
  const ids = f.locks.get(table) ?? new Set<string>();
  for (const row of rows) ids.add(String(row.id));
  f.locks.set(table, ids);
  return rows;
}
async function itemCases(client: Runner, f: Facts, patientId: number, ids: number[], expectedPlanId?: number | null) {
  if (!ids.length) return;
  const items = await read(client, f, "plan_items", "SELECT id, plan_id, case_id, status FROM plan_items WHERE id = ANY($1::int[]) ORDER BY id", [[...new Set(ids)].sort((a,b) => a-b)]);
  if (items.length !== new Set(ids).size) f.invalid = true;
  const plans = await read(client, f, "treatment_plans", "SELECT id, patient_id, status FROM treatment_plans WHERE id = ANY($1::int[]) ORDER BY id", [[...new Set(items.map(row => row.plan_id))].sort((a,b) => a-b)]);
  for (const item of items) {
    if (!validId(item.case_id) || item.status === "cancelled" || (expectedPlanId != null && item.plan_id !== expectedPlanId) || !plans.some(plan => plan.id === item.plan_id && plan.patient_id === patientId && plan.status !== "cancelled")) f.invalid = true;
    else f.cases.push({ kind: "clinical_case", id: item.case_id });
  }
}
async function visitCases(client: Runner, f: Facts, patientId: number, id: number) {
  const [visit] = await read(client, f, "visits", "SELECT id, patient_id, case_id FROM visits WHERE id = $1", [id]);
  if (!visit || visit.patient_id !== patientId) { f.invalid = true; return; }
  if (validId(visit.case_id)) f.cases.push({ kind: "clinical_case", id: visit.case_id });
  // Specialty records carry exact work provenance even when a legacy visit has
  // no generic case_id. Their historical treating-doctor columns are not read.
  const adjustments = await read(client, f, "ortho_adjustments", "SELECT id, case_id FROM ortho_adjustments WHERE visit_id = $1 ORDER BY id", [id]);
  for (const adjustment of adjustments) f.cases.push({ kind: "ortho_case", id: adjustment.case_id });
  const endoVisits = await read(client, f, "endo_visits", "SELECT id, treatment_id FROM endo_visits WHERE visit_id = $1 ORDER BY id", [id]);
  if (endoVisits.length) {
    const treatments = await read(client, f, "endo_treatments", "SELECT id, patient_id, case_id, status FROM endo_treatments WHERE id = ANY($1::int[]) ORDER BY id", [[...new Set(endoVisits.map(row => row.treatment_id))].sort((a,b) => a-b)]);
    if (treatments.length !== new Set(endoVisits.map(row => row.treatment_id)).size) f.invalid = true;
    for (const treatment of treatments) {
      if (treatment.patient_id !== patientId || !validId(treatment.case_id) || treatment.status === "abandoned") f.invalid = true;
      else f.cases.push({ kind: "clinical_case", id: treatment.case_id });
    }
  }
  const sessions = await read(client, f, "treatment_sessions", "SELECT id, plan_item_id FROM treatment_sessions WHERE visit_id = $1 AND status <> 'cancelled' ORDER BY id", [id]);
  const procedures = await read(client, f, "visit_procedures", "SELECT id, plan_item_id FROM visit_procedures WHERE visit_id = $1 AND plan_item_id IS NOT NULL ORDER BY id", [id]);
  await itemCases(client, f, patientId, [...sessions, ...procedures].map(row => row.plan_item_id));
}
async function sourceFacts(client: Runner, patientId: number, source: ReturnBookingSource): Promise<Facts> {
  const f = facts();
  if (source.kind === "clinical_case" || source.kind === "ortho_case") f.cases.push(source);
  else if (source.kind === "ortho_adjustment") {
    const [adjustment] = await read(client, f, "ortho_adjustments", "SELECT id, case_id FROM ortho_adjustments WHERE id = $1", [source.id]);
    if (!adjustment) f.invalid = true;
    else f.cases.push({ kind: "ortho_case", id: adjustment.case_id });
  } else if (source.kind === "plan_item") await itemCases(client, f, patientId, [source.id]);
  else if (source.kind === "visit") await visitCases(client, f, patientId, source.id);
  else if (source.kind === "planned_visit") {
    const [planned] = await read(client, f, "planned_visits", "SELECT id, patient_id, plan_id, visit_id, status FROM planned_visits WHERE id = $1", [source.id]);
    if (!planned || planned.patient_id !== patientId || planned.status === "cancelled") f.invalid = true;
    else {
      const sessions = await read(client, f, "treatment_sessions", "SELECT id, plan_item_id FROM treatment_sessions WHERE planned_visit_id = $1 AND status <> 'cancelled' ORDER BY id", [source.id]);
      if (sessions.length) await itemCases(client, f, patientId, sessions.map(row => row.plan_item_id), planned.plan_id);
      else if (validId(planned.visit_id)) await visitCases(client, f, patientId, planned.visit_id);
    }
  } else if (source.kind === "lab_work") {
    const [order] = await read(client, f, "lab_orders", "SELECT id, patient_id, visit_id, lab_work_intent_id, status FROM lab_orders WHERE id = $1", [source.id]);
    if (!order || order.patient_id !== patientId || order.status === "cancelled") f.invalid = true;
    else if (order.lab_work_intent_id) {
      const [intent] = await read(client, f, "lab_work_intents", "SELECT id, patient_id, state FROM lab_work_intents WHERE id = $1", [order.lab_work_intent_id]);
      const members = await read(client, f, "lab_work_members", "SELECT id, patient_id, plan_item_id FROM lab_work_members WHERE intent_id = $1 AND retired_revision IS NULL ORDER BY id", [order.lab_work_intent_id]);
      if (!intent || intent.patient_id !== patientId || intent.state !== "materialized" || !members.length || members.some(row => row.patient_id !== patientId || !validId(row.plan_item_id))) f.invalid = true;
      else await itemCases(client, f, patientId, members.map(row => row.plan_item_id));
    } else if (validId(order.visit_id)) await visitCases(client, f, patientId, order.visit_id);
  }
  return f;
}
async function caseChoice(client: Runner, f: Facts, patientId: number, source: ReturnBookingSource): Promise<ReturnBookingChoice | null> {
  let clinicalCaseId: number | null = null, orthoCaseId: number | null = null, doctorId: number | null = null;
  let label = "حالة تقويم الأسنان", status = "", specialty = "";
  if (source.kind === "clinical_case") {
    const [clinical] = await read(client, f, "clinical_cases", "SELECT id, patient_id, specialty, title, ortho_case_id, responsible_party_id, status FROM clinical_cases WHERE id = $1", [source.id]);
    if (!clinical || clinical.patient_id !== patientId) return null;
    clinicalCaseId = Number(clinical.id); orthoCaseId = clinical.ortho_case_id;
    doctorId = clinical.responsible_party_id; label = clinical.title; status = clinical.status; specialty = clinical.specialty;
  } else orthoCaseId = source.id;
  if (orthoCaseId !== null) {
    const [ortho] = await read(client, f, "ortho_cases", "SELECT id, patient_id, responsible_doctor_id, status FROM ortho_cases WHERE id = $1", [orthoCaseId]);
    const bridges = await read(client, f, "clinical_cases", "SELECT id, patient_id, specialty, title, ortho_case_id, responsible_party_id, status FROM clinical_cases WHERE ortho_case_id = $1 ORDER BY id", [orthoCaseId]);
    if (!ortho || ortho.patient_id !== patientId || bridges.length > 1 || bridges.some(row => row.patient_id !== patientId || row.specialty !== "orthodontics") || (clinicalCaseId !== null && specialty !== "orthodontics")) return null;
    clinicalCaseId = bridges.length ? Number(bridges[0].id) : clinicalCaseId;
    // A unique same-patient explicit clinical bridge is current-care authority
    // only when the canonical ortho field is unset; never use billed work.
    doctorId = ortho.responsible_doctor_id ?? bridges[0]?.responsible_party_id ?? null; status = ortho.status;
    if (bridges[0]) label = bridges[0].title;
  }
  const revision = await readResponsibilityRevision(client, patientId, clinicalCaseId === null ? [] : [clinicalCaseId], orthoCaseId);
  f.values.push(["responsibility_revision", clinicalCaseId, orthoCaseId, revision]);
  const [doctor] = doctorId === null ? [] : await read(client, f, "parties", "SELECT id, name, kind, is_active FROM parties WHERE id = $1", [doctorId]);
  const available = (orthoCaseId !== null ? ["active", "retention"] : ["active", "waiting"]).includes(status)
    && !!doctor && doctor.kind === "doctor" && doctor.is_active === true;
  const code = !(orthoCaseId !== null ? ["active", "retention"] : ["active", "waiting"]).includes(status) ? "return_source_closed"
    : doctorId === null ? "responsibility_missing" : !doctor || doctor.kind !== "doctor" || !doctor.is_active ? "responsibility_inactive" : undefined;
  return { source: orthoCaseId !== null ? { kind: "ortho_case", id: orthoCaseId } : { kind: "clinical_case", id: clinicalCaseId! },
    label, clinicalCaseId, orthoCaseId, doctorId: available ? doctorId : null, doctorName: available ? doctor.name : null,
    available, settingsTarget: { kind: orthoCaseId !== null ? "ortho" : "clinical", id: orthoCaseId ?? clinicalCaseId! },
    ...(code ? { code, message: code === "return_source_closed" ? "الحالة مغلقة؛ راجع السياق السريري قبل الحجز." : "يلزم تحديد طبيب مسؤول نشط من إعدادات مسؤولية الحالة قبل الحجز." } : {}) };
}
async function resolve(client: Runner, patientId: number, source: ReturnBookingSource, origin?: ReturnBookingSource) {
  const f = await sourceFacts(client, patientId, source);
  let originChoices: ReturnBookingChoice[] | null = null;
  if (origin && canonical(origin) !== canonical(source)) {
    const original = await sourceFacts(client, patientId, origin);
    if (original.invalid) return { result: missing(), f };
    originChoices = [];
    for (const candidate of original.cases) {
      const choice = await caseChoice(client, original, patientId, candidate);
      if (!choice) return { result: missing(), f };
      originChoices.push(choice);
    }
    f.values.push(["origin", origin, original.values]);
    for (const [table, ids] of original.locks) f.locks.set(table, new Set([...(f.locks.get(table) ?? []), ...ids]));
  }
  if (f.invalid || !f.cases.length) return { result: missing(), f };
  const choices = new Map<string, ReturnBookingChoice>();
  for (const candidate of f.cases) {
    const choice = await caseChoice(client, f, patientId, candidate);
    if (!choice) return { result: missing(), f };
    choices.set(canonical(choice.source), choice);
  }
  const contexts = [...choices.values()].sort((a,b) => canonical(a.source).localeCompare(canonical(b.source)));
  if (contexts.length !== 1) return { result: { ...refusal("return_source_ambiguous", "اختر الحالة أو العمل المحدد؛ هذا المصدر يرتبط بأكثر من سياق سريري."), contexts } as ReturnBookingResolution, f };
  const choice = contexts[0];
  if (originChoices && !originChoices.some(item => canonical(item.source) === canonical(choice.source))) return { result: missing(), f };
  if (!choice.available) return { result: { ok: false, code: choice.code!, message: choice.message!, contexts } as ReturnBookingResolution, f };
  const result: ReturnBookingResolution = { ok: true, patientId, source, clinicalCaseId: choice.clinicalCaseId, orthoCaseId: choice.orthoCaseId,
    doctorId: choice.doctorId!, doctorName: choice.doctorName!, fingerprint: hash([patientId,source,origin ?? null,f.values]), label: choice.label, settingsTarget: choice.settingsTarget };
  return { result, f };
}
/** The caller owns a transaction for lock=true. No financial attribution field is
 * a current-care authority. Every read is patient-scoped, with no roster fallback. */
export async function readReturnBookingContext(client: Runner, patientId: number, source: ReturnBookingSource,
  options: { lock?: boolean; origin?: ReturnBookingSource } = {}): Promise<ReturnBookingResolution> {
  if (!validId(patientId) || !parseReturnBookingSource(source) || (options.origin && !parseReturnBookingSource(options.origin))) return missing();
  // A URL-inferred intrinsic source is identical to an explicit self-origin.
  // Canonicalize before hashing so GET preview and transactional writers agree.
  const origin = options.origin && canonical(options.origin) !== canonical(source) ? options.origin : undefined;
  const first = await resolve(client, patientId, source, origin);
  if (!options.lock) return first.result;
  // Acquire only already-observed rows; NOWAIT fails closed rather than invert
  // clinical writer ordering. Re-read everything after locks, including links.
  for (const [table, ids] of [...first.f.locks].sort(([a],[b]) => a.localeCompare(b))) {
    if (!ids.size) continue;
    const cast = table === "lab_work_intents" || table === "lab_work_members" ? "uuid" : "bigint";
    await client.query(`SELECT id FROM ${table} WHERE id = ANY($1::${cast}[]) ORDER BY id FOR SHARE NOWAIT`, [[...ids].sort()]);
  }
  const second = await resolve(client, patientId, source, origin);
  if (hash(first.f.values) !== hash(second.f.values)) return changed();
  return second.result;
}
export async function listReturnBookingContexts(client: Runner, patientId: number): Promise<ReturnBookingChoice[]> {
  const { rows } = await client.query<{ id: number; kind: "clinical_case" | "ortho_case" }>(
    `SELECT id, 'clinical_case'::text AS kind FROM clinical_cases WHERE patient_id = $1 AND status IN ('active','waiting')
     UNION ALL SELECT o.id, 'ortho_case'::text AS kind FROM ortho_cases o WHERE o.patient_id = $1 AND o.status IN ('active','retention')
       AND NOT EXISTS (SELECT 1 FROM clinical_cases c WHERE c.ortho_case_id = o.id) ORDER BY kind, id`, [patientId]);
  const choices: ReturnBookingChoice[] = [];
  for (const row of rows) { const choice = await caseChoice(client, facts(), patientId, row); if (choice) choices.push(choice); }
  return choices;
}
