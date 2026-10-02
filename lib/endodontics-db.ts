import { IDEMPOTENCY_KEY_PATTERN } from "./idempotency-key";
/**
 * (ENDO-2) طبقة قاعدة بيانات علاج العصب — نوبات السن وسجلات الزيارات والقنوات والملاحق.
 *
 * القواعد التي تحملها هذه الطبقة (لا الواجهة):
 *  - **العزل**: كل دالةٍ تأخذ `patientId` وتتحقق أن النوبة لهذا المريض — نوبةٌ لمريضٍ آخر تُعامَل «غير موجودة».
 *  - **التجميد بالتوقيع**: لا يُكتب سجلٌّ على زيارةٍ موقَّعة؛ التصحيح ملحقٌ إلحاقيّ يحمل كاتبه ووقته.
 *  - **الطبيب**: الطبيب المسجَّل ثم طبيب إجراء الجذور المطابق ثم طبيب الزيارة ثم الموقِّع (إن كان طبيبًا) — لا طبيب جديدٌ بقواعد جديدة، وبلا طبيبٍ يُرفض الحفظ.
 *  - **التزامن**: قفل صفّ النوبة ثم الزيارة؛ والتعديل يشترط رقم إصدار السجل (`expectedVersion`).
 *  - **التكرار**: المحاولة المعادَة بالمحتوى نفسه تنجح بلا أثرٍ ثانٍ؛ بمحتوى مختلف ودون إصدارٍ تُرفض.
 *  - **المال**: لا شيء هنا؛ الفوترة تبقى على إجراءات الزيارة وبنود الخطة.
 */
import {
  ensureSchema, getPool, insertAuditRow, addPlanItemDependencyInTransaction, type DbClient,
} from "./db";
import {
  canCompleteEndo, canMoveEndo, checkEndoAddendum, hasMeaningfulEndoRecord, crownState, endoNextAction, mergeRestorative, sameVisitDraft, summarizeEndo,
  type CanalSummary, type CrownState, type EndoCanalDraft, type EndoKind, type EndoStatus, type EndoSummary,
  type EndoVisitDraft, type EndoVisitRecord, type RestorativeStatus,
} from "./endodontics";
import { isValidTooth, toothName } from "./dental";

export interface EndoAddendum { id: number; body: string; author: string; createdAt: string }

export interface EndoVisitView extends EndoVisitRecord {
  treatmentId: number;
  version: number;
  recordedBy: string;
  updatedAt: string | null;
  doctorName: string | null;
  addenda: EndoAddendum[];
}

export interface EndoTreatmentView {
  id: number;
  patientId: number;
  caseId: number;
  caseTitle: string;
  toothCode: number;
  toothName: string;
  kind: EndoKind;
  status: EndoStatus;
  completedAt: string | null;
  outcome: string | null;
  restorativeStatus: RestorativeStatus;
  crownRequired: boolean | null;
  crownPlanItem: { id: number; name: string; status: string } | null;
  version: number;
  createdBy: string;
  createdAt: string;
  visits: EndoVisitView[];
  summary: EndoSummary;
  crown: CrownState;
  nextAction: string;
}

interface TreatmentRow {
  id: number; patient_id: number; case_id: number; case_title: string; tooth_code: number; kind: EndoKind;
  status: EndoStatus; completed_at: Date | null; outcome: string | null; restorative_status: RestorativeStatus;
  crown_required: boolean | null; crown_plan_item_id: number | null; crown_item_name: string | null;
  crown_item_status: string | null; version: number; created_by: string; created_at: Date;
}

interface VisitRow {
  id: number; treatment_id: number; visit_id: number; doctor_id: number | null; doctor_name: string | null;
  stage: EndoVisitDraft["stage"]; chief_complaint: string | null; symptoms: string | null;
  pulpal_diagnosis: EndoVisitDraft["pulpalDiagnosis"]; apical_diagnosis: EndoVisitDraft["apicalDiagnosis"];
  vitality_cold: EndoVisitDraft["vitalityCold"]; vitality_heat: EndoVisitDraft["vitalityHeat"];
  vitality_ept: EndoVisitDraft["vitalityEpt"]; percussion: EndoVisitDraft["percussion"];
  palpation: EndoVisitDraft["palpation"]; mobility_grade: number | null; perio_findings: string | null;
  previous_treatment: string | null; radiographic_findings: string | null; canals_found: number | null;
  instrumentation: string | null; irrigation: string | null; medicament: string | null;
  obturation_technique: string | null; obturation_material: string | null;
  restoration_after: EndoVisitDraft["restorationAfter"]; complications: string | null;
  prognosis: EndoVisitDraft["prognosis"]; next_step: string | null; next_visit_weeks: number | null;
  note: string | null; version: number; recorded_by: string; recorded_at: Date; updated_at: Date | null;
  signed_at: Date | null;
}

interface CanalRow {
  endo_visit_id: number; canal_label: string; working_length_mm: string | null;
  reference_point: EndoCanalDraft["referencePoint"]; measurement_method: EndoCanalDraft["measurementMethod"];
  master_apical_size: number | null; taper_percent: number | null; instrumentation: string | null;
  obturated: boolean; note: string | null;
}

const toCanal = (row: CanalRow): EndoCanalDraft => ({
  label: row.canal_label,
  workingLengthMm: row.working_length_mm === null ? null : Number(row.working_length_mm),
  referencePoint: row.reference_point, measurementMethod: row.measurement_method,
  masterApicalSize: row.master_apical_size, taperPercent: row.taper_percent,
  instrumentation: row.instrumentation, obturated: row.obturated, note: row.note,
});

const toVisit = (row: VisitRow, canals: EndoCanalDraft[], addenda: EndoAddendum[]): EndoVisitView => ({
  id: row.id, treatmentId: row.treatment_id, visitId: row.visit_id, doctorId: row.doctor_id, doctorName: row.doctor_name,
  recordedAt: row.recorded_at.toISOString(), signed: row.signed_at !== null,
  stage: row.stage, chiefComplaint: row.chief_complaint, symptoms: row.symptoms,
  pulpalDiagnosis: row.pulpal_diagnosis, apicalDiagnosis: row.apical_diagnosis,
  vitalityCold: row.vitality_cold, vitalityHeat: row.vitality_heat, vitalityEpt: row.vitality_ept,
  percussion: row.percussion, palpation: row.palpation, mobilityGrade: row.mobility_grade,
  perioFindings: row.perio_findings, previousTreatment: row.previous_treatment,
  radiographicFindings: row.radiographic_findings, canalsFound: row.canals_found,
  instrumentation: row.instrumentation, irrigation: row.irrigation, medicament: row.medicament,
  obturationTechnique: row.obturation_technique, obturationMaterial: row.obturation_material,
  restorationAfter: row.restoration_after, complications: row.complications, prognosis: row.prognosis,
  nextStep: row.next_step, nextVisitWeeks: row.next_visit_weeks, note: row.note, canals,
  version: row.version, recordedBy: row.recorded_by,
  updatedAt: row.updated_at ? row.updated_at.toISOString() : null, addenda,
});

const VISIT_SELECT = `
  SELECT ev.*, d.name AS doctor_name, v.signed_at
    FROM endo_visits ev
    JOIN visits v ON v.id = ev.visit_id
    LEFT JOIN parties d ON d.id = ev.doctor_id`;

/** A persisted empty draft is not clinical work and cannot authorize sign-off. */
export async function hasMeaningfulEndoVisit(client: Pick<DbClient, "query">, visitId: number): Promise<boolean> {
  const { rows: visits } = await client.query<VisitRow>(`${VISIT_SELECT} WHERE ev.visit_id = $1 ORDER BY ev.id`, [visitId]);
  if (!visits.length) return false;
  const { rows: canals } = await client.query<CanalRow>(
    `SELECT * FROM endo_canal_records WHERE endo_visit_id = ANY($1::int[]) ORDER BY id`, [visits.map((row) => row.id)]);
  return visits.some((row) => hasMeaningfulEndoRecord(toVisit(row, canals.filter((canal) => canal.endo_visit_id === row.id).map(toCanal), [])));
}

async function loadViews(client: Pick<DbClient, "query">, rows: TreatmentRow[]): Promise<EndoTreatmentView[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const { rows: visitRows } = await client.query<VisitRow>(`${VISIT_SELECT} WHERE ev.treatment_id = ANY($1::int[]) ORDER BY ev.id`, [ids]);
  const visitIds = visitRows.map((row) => row.id);
  const { rows: canalRows } = visitIds.length === 0 ? { rows: [] as CanalRow[] }
    : await client.query<CanalRow>(`SELECT * FROM endo_canal_records WHERE endo_visit_id = ANY($1::int[]) ORDER BY id`, [visitIds]);
  const { rows: addendaRows } = visitIds.length === 0 ? { rows: [] as (EndoAddendum & { endo_visit_id: number; created_at: Date })[] }
    : await client.query<EndoAddendum & { endo_visit_id: number; created_at: Date }>(
      `SELECT id, endo_visit_id, body, author, created_at FROM endo_addenda WHERE endo_visit_id = ANY($1::int[]) ORDER BY id`, [visitIds]);

  return rows.map((row) => {
    const visits = visitRows.filter((visit) => visit.treatment_id === row.id).map((visit) => toVisit(
      visit,
      canalRows.filter((canal) => canal.endo_visit_id === visit.id).map(toCanal),
      addendaRows.filter((a) => a.endo_visit_id === visit.id)
        .map((a) => ({ id: a.id, body: a.body, author: a.author, createdAt: a.created_at.toISOString() })),
    ));
    const summary = summarizeEndo(visits, new Map(visits.map((visit) => [visit.id, visit.canals])));
    const crown = crownState({
      status: row.status, crownRequired: row.crown_required, restorative: row.restorative_status,
      crownItemDone: row.crown_item_status === "done",
    });
    return {
      id: row.id, patientId: row.patient_id, caseId: row.case_id, caseTitle: row.case_title,
      toothCode: row.tooth_code, toothName: toothName(row.tooth_code), kind: row.kind, status: row.status,
      completedAt: row.completed_at ? row.completed_at.toISOString() : null, outcome: row.outcome,
      restorativeStatus: row.restorative_status, crownRequired: row.crown_required,
      crownPlanItem: row.crown_plan_item_id === null ? null
        : { id: row.crown_plan_item_id, name: row.crown_item_name ?? "—", status: row.crown_item_status ?? "—" },
      version: row.version, createdBy: row.created_by, createdAt: row.created_at.toISOString(),
      visits, summary, crown,
      nextAction: endoNextAction({ status: row.status, summary, restorative: row.restorative_status, crown }),
    };
  });
}

const TREATMENT_SELECT = `
  SELECT t.*, c.title AS case_title, i.service_name AS crown_item_name, i.status AS crown_item_status
    FROM endo_treatments t
    JOIN clinical_cases c ON c.id = t.case_id
    LEFT JOIN plan_items i ON i.id = t.crown_plan_item_id`;

/** كل نوبات علاج الجذور للمريض — الأحدث أولًا، بزياراتها وقنواتها وملاحقها وحالتها الراهنة. */
export async function listPatientEndo(patientId: number): Promise<EndoTreatmentView[]> {
  await ensureSchema();
  const pool = getPool();
  const { rows } = await pool.query<TreatmentRow>(
    `${TREATMENT_SELECT} WHERE t.patient_id = $1 ORDER BY t.created_at DESC, t.id DESC`, [patientId]);
  return loadViews(pool, rows);
}

async function oneView(client: Pick<DbClient, "query">, treatmentId: number): Promise<EndoTreatmentView> {
  const { rows } = await client.query<TreatmentRow>(`${TREATMENT_SELECT} WHERE t.id = $1`, [treatmentId]);
  return (await loadViews(client, rows))[0];
}

interface Actor { actor: string; actorRole?: string | null }

// ─── فتح نوبة ────────────────────────────────────────────────────────────────

export type OpenEndoRefusal = "no_patient" | "bad_tooth" | "bad_case" | "case_closed" | "tooth_busy";
export const OPEN_ENDO_MESSAGE: Record<OpenEndoRefusal, string> = {
  no_patient: "لا يوجد مريض بهذا الرقم.",
  bad_tooth: "السن غير صالح (ترقيم FDI).",
  bad_case: "الحالة المختارة ليست حالة علاج جذور لهذا المريض.",
  case_closed: "حالة علاج الجذور منتهية — افتح حالةً جديدة.",
  tooth_busy: "هذا السن عليه علاج جذورٍ جارٍ — أكمله أو أوقفه أولًا.",
};

export async function openEndoTreatment(input: Actor & {
  patientId: number; caseId: number; toothCode: number; kind: EndoKind;
}): Promise<{ ok: true; treatment: EndoTreatmentView } | { ok: false; reason: OpenEndoRefusal }> {
  await ensureSchema();
  if (!isValidTooth(input.toothCode)) return { ok: false, reason: "bad_tooth" };
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // قفل المريض يسلسل فتح نوبتين متزامنتين على السن نفسه (والفهرس الفريد حارسٌ أخير).
    const { rows: patient } = await client.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [input.patientId]);
    if (!patient[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "no_patient" }; }
    const { rows: cases } = await client.query<{ specialty: string; status: string; title: string }>(
      `SELECT specialty, status, title FROM clinical_cases WHERE id = $1 AND patient_id = $2 FOR SHARE`, [input.caseId, input.patientId]);
    if (!cases[0] || cases[0].specialty !== "endodontics") { await client.query("ROLLBACK"); return { ok: false, reason: "bad_case" }; }
    if (cases[0].status !== "active" && cases[0].status !== "waiting") { await client.query("ROLLBACK"); return { ok: false, reason: "case_closed" }; }
    const { rows: busy } = await client.query(
      `SELECT 1 FROM endo_treatments WHERE patient_id = $1 AND tooth_code = $2 AND status = 'in_progress'`,
      [input.patientId, input.toothCode]);
    if (busy[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "tooth_busy" }; }
    const { rows: [created] } = await client.query<{ id: number }>(
      `INSERT INTO endo_treatments (patient_id, case_id, tooth_code, kind, created_by)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [input.patientId, input.caseId, input.toothCode, input.kind, input.actor]);
    await insertAuditRow(client, {
      action: "endo.open", entity: "patient", entityId: input.patientId, entityLabel: toothName(input.toothCode),
      details: { النوبة: created.id, السن: input.toothCode, الحالة: input.caseId, النوع: input.kind },
      actor: input.actor, actorRole: input.actorRole ?? null,
    });
    await client.query("COMMIT");
    return { ok: true, treatment: await oneView(client, created.id) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ─── حفظ سجل زيارة ───────────────────────────────────────────────────────────

export type SaveEndoVisitRefusal =
  | "not_found" | "closed" | "visit_not_found" | "wrong_patient" | "visit_signed"
  | "no_treating_doctor" | "ambiguous_doctor" | "exists" | "version_conflict";
export const SAVE_ENDO_VISIT_MESSAGE: Record<SaveEndoVisitRefusal, string> = {
  not_found: "نوبة العلاج غير موجودة.",
  closed: "نوبة العلاج منتهية — لا تُسجَّل عليها زيارات.",
  visit_not_found: "الزيارة غير موجودة.",
  wrong_patient: "الزيارة لمريضٍ آخر.",
  visit_signed: "الزيارة موقَّعة — التصحيح يكون بملحق.",
  no_treating_doctor: "حدّد الطبيب المعالج للزيارة أولًا — لا يُسجَّل علاجٌ بلا طبيب.",
  ambiguous_doctor: "يوجد أكثر من طبيب لإجراءات علاج الجذور على هذا السن — راجع نسبة الإجراءات أولًا.",
  exists: "يوجد سجلٌّ لهذه الزيارة بمحتوى آخر — حمّله وعدّله بدل إنشاء سجلٍّ جديد.",
  version_conflict: "عدّل هذا السجل شخصٌ آخر قبلك — أعد التحميل ثم أعد المحاولة.",
};

const DRAFT_COLUMNS = [
  "stage", "chief_complaint", "symptoms", "pulpal_diagnosis", "apical_diagnosis", "vitality_cold", "vitality_heat",
  "vitality_ept", "percussion", "palpation", "mobility_grade", "perio_findings", "previous_treatment",
  "radiographic_findings", "canals_found", "instrumentation", "irrigation", "medicament", "obturation_technique",
  "obturation_material", "restoration_after", "complications", "prognosis", "next_step", "next_visit_weeks", "note",
] as const;

function draftValues(d: EndoVisitDraft): unknown[] {
  return [
    d.stage, d.chiefComplaint, d.symptoms, d.pulpalDiagnosis, d.apicalDiagnosis, d.vitalityCold, d.vitalityHeat,
    d.vitalityEpt, d.percussion, d.palpation, d.mobilityGrade, d.perioFindings, d.previousTreatment,
    d.radiographicFindings, d.canalsFound, d.instrumentation, d.irrigation, d.medicament, d.obturationTechnique,
    d.obturationMaterial, d.restorationAfter, d.complications, d.prognosis, d.nextStep, d.nextVisitWeeks, d.note,
  ];
}

const asDraft = (view: EndoVisitView): EndoVisitDraft => {
  const { id: _id, treatmentId: _t, visitId: _v, doctorId: _d, doctorName: _dn, recordedAt: _r, signed: _s,
    version: _ver, recordedBy: _rb, updatedAt: _u, addenda: _a, ...draft } = view;
  return draft as EndoVisitDraft;
};

export async function saveEndoVisit(input: Actor & {
  patientId: number; treatmentId: number; visitId: number; draft: EndoVisitDraft;
  /** رقم إصدار السجل الذي عدّله المستخدم — يلزم لتعديل سجلٍّ قائم. */
  expectedVersion: number | null;
  /** جهة الطبيب الموقِّع إن كان صاحب الجلسة طبيبًا. */
  actorPartyId: number | null;
}): Promise<{ ok: true; created: boolean; unchanged: boolean; treatment: EndoTreatmentView } | { ok: false; reason: SaveEndoVisitRefusal }> {
  await ensureSchema();
  const client = await getPool().connect();
  const refuse = async (reason: SaveEndoVisitRefusal) => { await client.query("ROLLBACK"); return { ok: false as const, reason }; };
  try {
    await client.query("BEGIN");
    const { rows: treatments } = await client.query<{
      patient_id: number; status: EndoStatus; tooth_code: number; case_id: number; restorative_status: RestorativeStatus;
    }>(`SELECT patient_id, status, tooth_code, case_id, restorative_status FROM endo_treatments WHERE id = $1 AND patient_id = $2 FOR UPDATE`,
      [input.treatmentId, input.patientId]);
    const treatment = treatments[0];
    if (!treatment) return refuse("not_found");
    if (treatment.status !== "in_progress") return refuse("closed");

    const { rows: visits } = await client.query<{ patient_id: number | null; doctor_id: number | null; signed_at: Date | null }>(
      `SELECT patient_id, doctor_id, signed_at FROM visits WHERE id = $1 FOR UPDATE`, [input.visitId]);
    const visit = visits[0];
    if (!visit) return refuse("visit_not_found");
    if (visit.patient_id !== input.patientId) return refuse("wrong_patient");
    if (visit.signed_at !== null) return refuse("visit_signed");

    const { rows: existingRows } = await client.query<VisitRow>(
      `${VISIT_SELECT} WHERE ev.treatment_id = $1 AND ev.visit_id = $2 FOR UPDATE OF ev`, [input.treatmentId, input.visitId]);
    // Preserve recorded attribution. For new records the matching RCT procedure's
    // explicit provider precedes the visit/signing fallback, just as billing does.
    const { rows: providers } = await client.query<{ doctor_id: number }>(
      `SELECT DISTINCT p.doctor_id FROM visit_procedures p JOIN services s ON s.id = p.service_id
        LEFT JOIN plan_items i ON i.id = p.plan_item_id
        WHERE p.visit_id = $1 AND p.tooth_code = $2 AND s.category = 'rct' AND p.doctor_id IS NOT NULL
          AND (i.case_id IS NULL OR i.case_id = $3)`,
      [input.visitId, treatment.tooth_code, treatment.case_id]);
    if (!existingRows[0]?.doctor_id && providers.length > 1) return refuse("ambiguous_doctor");
    const fixedDoctor = existingRows[0]?.doctor_id ?? providers[0]?.doctor_id ?? null;
    const candidates = fixedDoctor !== null ? [fixedDoctor]
      : [visit.doctor_id, input.actorPartyId].filter((id): id is number => typeof id === "number" && id > 0);
    const { rows: doctors } = candidates.length === 0 ? { rows: [] as { id: number }[] }
      : await client.query<{ id: number }>(`SELECT id FROM parties WHERE id = ANY($1::int[]) AND kind = 'doctor'`, [candidates]);
    const real = new Set(doctors.map((row) => row.id));
    const doctorId = candidates.find((id) => real.has(id)) ?? null;
    if (doctorId === null) return refuse("no_treating_doctor");

    const draft = input.draft;
    let endoVisitId: number;
    let created = false;
    let changed: string[] = [];

    if (existingRows[0]) {
      const current = existingRows[0];
      const { rows: canalRows } = await client.query<CanalRow>(`SELECT * FROM endo_canal_records WHERE endo_visit_id = $1 ORDER BY id`, [current.id]);
      const before = toVisit(current, canalRows.map(toCanal), []);
      if ((input.expectedVersion === null || input.expectedVersion <= current.version)
          && sameVisitDraft(asDraft(before), draft)) {
        await client.query("ROLLBACK");
        return { ok: true, created: false, unchanged: true, treatment: await oneView(client, input.treatmentId) };
      }
      if (input.expectedVersion === null) return refuse("exists");
      if (input.expectedVersion !== current.version) return refuse("version_conflict");
      endoVisitId = current.id;
      changed = (DRAFT_COLUMNS as readonly string[]).filter((column, index) => {
        const next = draftValues(draft)[index];
        return (current as unknown as Record<string, unknown>)[column] !== next;
      });
      const beforeCanals = JSON.stringify([...before.canals].sort((a, b) => a.label.localeCompare(b.label)));
      const afterCanals = JSON.stringify([...draft.canals].sort((a, b) => a.label.localeCompare(b.label)));
      if (beforeCanals !== afterCanals) changed.push("canals");
      await client.query(
        `UPDATE endo_visits SET ${DRAFT_COLUMNS.map((column, index) => `${column} = $${index + 3}`).join(", ")},
                doctor_id = $${DRAFT_COLUMNS.length + 3}, version = version + 1, updated_by = $${DRAFT_COLUMNS.length + 4}, updated_at = NOW()
          WHERE id = $1 AND version = $2`,
        [current.id, current.version, ...draftValues(draft), doctorId, input.actor]);
      await client.query(`DELETE FROM endo_canal_records WHERE endo_visit_id = $1`, [current.id]);
    } else {
      if (input.expectedVersion !== null) return refuse("version_conflict");
      const { rows: [row] } = await client.query<{ id: number }>(
        `INSERT INTO endo_visits (treatment_id, visit_id, doctor_id, recorded_by, ${DRAFT_COLUMNS.join(", ")})
         VALUES ($1, $2, $3, $4, ${DRAFT_COLUMNS.map((_, index) => `$${index + 5}`).join(", ")}) RETURNING id`,
        [input.treatmentId, input.visitId, doctorId, input.actor, ...draftValues(draft)]);
      endoVisitId = row.id;
      created = true;
    }

    for (const canal of draft.canals) {
      await client.query(
        `INSERT INTO endo_canal_records
           (endo_visit_id, canal_label, working_length_mm, reference_point, measurement_method,
            master_apical_size, taper_percent, instrumentation, obturated, note)
         VALUES ($1, $2, $3::numeric, $4::text, $5::text, $6::smallint, $7::smallint, $8::text, $9, $10::text)`,
        [endoVisitId, canal.label, canal.workingLengthMm, canal.referencePoint, canal.measurementMethod,
          canal.masterApicalSize, canal.taperPercent, canal.instrumentation, canal.obturated, canal.note]);
    }
    // Derive from current records, so correcting/removing an unsigned draft's
    // restoration cannot leave an irreversible cached "permanent" state behind.
    const { rows: restorations } = await client.query<{ restoration_after: RestorativeStatus | null }>(
      `SELECT restoration_after FROM endo_visits WHERE treatment_id = $1 ORDER BY id`, [input.treatmentId]);
    const restorative = restorations.reduce<RestorativeStatus>((state, row) => mergeRestorative(state, row.restoration_after), "none");
    await client.query(
      `UPDATE endo_treatments SET restorative_status = $2, version = version + 1, updated_at = NOW() WHERE id = $1`,
      [input.treatmentId, restorative]);
    await insertAuditRow(client, {
      action: "endo.visit_save", entity: "patient", entityId: input.patientId, entityLabel: toothName(treatment.tooth_code),
      details: {
        النوبة: input.treatmentId, الزيارة: input.visitId, السجل: endoVisitId, السن: treatment.tooth_code,
        المرحلة: draft.stage, الطبيب: doctorId, القنوات: draft.canals.map((c) => c.label).join("،") || "—",
        ...(created ? { إنشاء: "نعم" } : { الحقول_المعدّلة: changed.join("،") || "—" }),
      },
      actor: input.actor, actorRole: input.actorRole ?? null,
    });
    await client.query("COMMIT");
    return { ok: true, created, unchanged: false, treatment: await oneView(client, input.treatmentId) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ─── ملحق على سجلٍّ موقَّع ────────────────────────────────────────────────────

export type EndoAddendumRefusal = "not_found" | "not_signed" | "bad_key" | "bad_text" | "idempotency_conflict";
export const ENDO_ADDENDUM_MESSAGE: Record<EndoAddendumRefusal, string> = {
  not_found: "سجل علاج الجذور غير موجود.",
  bad_text: "اكتب نص الملحق.",
  bad_key: "مفتاح إعادة محاولة الملحق غير صالح.",
  idempotency_conflict: "استُخدم مفتاح الملحق بمحتوى أو كاتب مختلف — أعد تحميل السجل.",
  not_signed: "الزيارة لم تُوقَّع بعد — عدّل السجل مباشرةً بدل الملحق.",
};

/** الملحق يُضاف ولا يمحو ولا يعدّل — ولا يُقبل إلا على زيارةٍ موقَّعة (قبلها التعديل مباشر). */
export async function addEndoAddendum(input: Actor & {
  patientId: number; treatmentId: number; endoVisitId: number; text: string; requestKey: string;
}): Promise<{ ok: true; created: boolean; treatment: EndoTreatmentView } | { ok: false; reason: EndoAddendumRefusal }> {
  if (typeof input.requestKey !== "string" || !IDEMPOTENCY_KEY_PATTERN.test(input.requestKey)) return { ok: false, reason: "bad_key" };
  const body = checkEndoAddendum({ text: input.text });
  if (!body.ok) return { ok: false, reason: "bad_text" };
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ signed_at: Date | null; visit_id: number; tooth_code: number }>(
      `SELECT v.signed_at, ev.visit_id, t.tooth_code
         FROM endo_visits ev
         JOIN endo_treatments t ON t.id = ev.treatment_id
         JOIN visits v ON v.id = ev.visit_id
        WHERE ev.id = $1 AND ev.treatment_id = $2 AND t.patient_id = $3
          FOR UPDATE OF ev`,
      [input.endoVisitId, input.treatmentId, input.patientId]);
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (rows[0].signed_at === null) { await client.query("ROLLBACK"); return { ok: false, reason: "not_signed" }; }
    const { rows: prior } = await client.query<{ body: string; author: string }>(
      `SELECT body, author FROM endo_addenda WHERE endo_visit_id = $1 AND request_key = $2`,
      [input.endoVisitId, input.requestKey]);
    if (prior[0]) {
      await client.query("ROLLBACK");
      if (prior[0].body !== body.value || prior[0].author !== input.actor) return { ok: false, reason: "idempotency_conflict" };
      return { ok: true, created: false, treatment: await oneView(client, input.treatmentId) };
    }
    const { rows: [addendum] } = await client.query<{ id: number }>(
      `INSERT INTO endo_addenda (endo_visit_id, body, author, request_key) VALUES ($1, $2, $3, $4) RETURNING id`,
      [input.endoVisitId, body.value, input.actor, input.requestKey]);
    await insertAuditRow(client, {
      action: "endo.addendum", entity: "patient", entityId: input.patientId, entityLabel: toothName(rows[0].tooth_code),
      details: { النوبة: input.treatmentId, السجل: input.endoVisitId, الملحق: addendum.id, الزيارة: rows[0].visit_id },
      actor: input.actor, actorRole: input.actorRole ?? null,
    });
    await client.query("COMMIT");
    return { ok: true, created: true, treatment: await oneView(client, input.treatmentId) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ─── إكمال/إيقاف ─────────────────────────────────────────────────────────────

export type EndoStatusRefusal = "not_found" | "invalid_transition" | "not_ready" | "unsigned_visit";
export const ENDO_STATUS_MESSAGE: Record<Exclude<EndoStatusRefusal, "not_ready">, string> = {
  not_found: "نوبة العلاج غير موجودة.",
  invalid_transition: "النوبة المنتهية لا تُفتح من جديد — ابدأ نوبةً جديدة على السن.",
  unsigned_visit: "وقّع زيارة العلاج أولًا — لا تُكمل نوبةٌ وسجلّها مفتوح.",
};

export async function changeEndoStatus(input: Actor & {
  patientId: number; treatmentId: number; status: Exclude<EndoStatus, "in_progress">; outcome: string | null;
}): Promise<{ ok: true; treatment: EndoTreatmentView } | { ok: false; reason: EndoStatusRefusal; message?: string }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ status: EndoStatus; tooth_code: number; restorative_status: RestorativeStatus }>(
      `SELECT status, tooth_code, restorative_status FROM endo_treatments WHERE id = $1 AND patient_id = $2 FOR UPDATE`,
      [input.treatmentId, input.patientId]);
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (!canMoveEndo(rows[0].status, input.status)) { await client.query("ROLLBACK"); return { ok: false, reason: "invalid_transition" }; }
    if (input.status === "completed") {
      const view = await oneView(client, input.treatmentId);
      if (view.visits.some((visit) => !visit.signed)) { await client.query("ROLLBACK"); return { ok: false, reason: "unsigned_visit" }; }
      const check = canCompleteEndo(view.summary, rows[0].restorative_status);
      if (!check.ok) { await client.query("ROLLBACK"); return { ok: false, reason: "not_ready", message: check.message }; }
    }
    await client.query(
      `UPDATE endo_treatments
          SET status = $2, completed_at = NOW(), outcome = COALESCE($3::text, outcome), version = version + 1, updated_at = NOW()
        WHERE id = $1`,
      [input.treatmentId, input.status, input.outcome]);
    await insertAuditRow(client, {
      action: "endo.status", entity: "patient", entityId: input.patientId, entityLabel: toothName(rows[0].tooth_code),
      details: { النوبة: input.treatmentId, من: rows[0].status, إلى: input.status, النتيجة: input.outcome ?? "—" },
      actor: input.actor, actorRole: input.actorRole ?? null,
    });
    await client.query("COMMIT");
    return { ok: true, treatment: await oneView(client, input.treatmentId) };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

// ─── اعتمادية التاج بعد علاج الجذور ──────────────────────────────────────────

export type EndoCrownRefusal = "not_found" | "bad_item" | "bad_rct" | "dependency_conflict" | "plan_forbidden" | "closed";
export const ENDO_CROWN_MESSAGE: Record<EndoCrownRefusal, string> = {
  not_found: "نوبة العلاج غير موجودة.",
  bad_item: "بند التاج يجب أن يكون من خطة هذا المريض ولهذا السن.",
  bad_rct: "اختر بند علاج جذور لهذه الحالة ونفس السن من خطة هذا المريض.",
  plan_forbidden: "تعديل ربط الخطة غير مفعّل لحسابك.",
  dependency_conflict: "تعذّر ربط التاج باكتمال علاج الجذور — راجع اعتماديات الخطة.",
  closed: "نوبة العلاج موقوفة — لا يُسجَّل لها قرار تاج.",
};

/**
 * قرار التاج: لازم/غير لازم، وربطه ببند التاج في خطة المريض. وإن أُعطي بند علاج الجذور في الخطة
 * فاعتمادية «التاج بعد اكتمال علاج الجذور» تُسجَّل بآلية اعتماديات بنود الخطة نفسها
 * (`addPlanItemDependency`) — لا نظام اعتمادٍ ثانٍ.
 */
export async function setEndoCrown(input: Actor & {
  patientId: number; treatmentId: number; crownRequired: boolean;
  crownPlanItemId: number | null; rctPlanItemId: number | null;
  canEditPlanLinks?: boolean;
}): Promise<{ ok: true; treatment: EndoTreatmentView } | { ok: false; reason: EndoCrownRefusal }> {
  await ensureSchema();
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    // Patient before treatment/items: the same serialization lock as the shared
    // dependency writer, also used by concurrent episode creation.
    await client.query(`SELECT id FROM patients WHERE id = $1 FOR UPDATE`, [input.patientId]);
    const { rows } = await client.query<{ status: EndoStatus; tooth_code: number; case_id: number; crown_required: boolean | null; crown_plan_item_id: number | null }>(
      `SELECT status, tooth_code, case_id, crown_required, crown_plan_item_id FROM endo_treatments WHERE id = $1 AND patient_id = $2 FOR UPDATE`,
      [input.treatmentId, input.patientId]);
    if (!rows[0]) { await client.query("ROLLBACK"); return { ok: false, reason: "not_found" }; }
    if (rows[0].status === "abandoned") { await client.query("ROLLBACK"); return { ok: false, reason: "closed" }; }
    const crownId = input.crownRequired ? input.crownPlanItemId : null;
    const refuse = async (reason: EndoCrownRefusal) => { await client.query("ROLLBACK"); return { ok: false as const, reason }; };
    if (input.canEditPlanLinks === false && (rows[0].crown_plan_item_id !== crownId || input.rctPlanItemId !== null)) return refuse("plan_forbidden");
    if (input.rctPlanItemId !== null && crownId === null) return refuse("bad_rct");
    if (crownId !== null) {
      if (input.rctPlanItemId === null || input.rctPlanItemId === crownId) return refuse("bad_rct");
      const { rows: items } = await client.query<{ id: number; category: string | null; case_id: number | null }>(
        `SELECT i.id, i.category, i.case_id FROM plan_items i JOIN treatment_plans p ON p.id = i.plan_id
          WHERE i.id = ANY($1::int[]) AND p.patient_id = $2 AND i.tooth_code = $3
            AND i.status <> 'cancelled' AND p.status <> 'cancelled' ORDER BY i.id FOR SHARE OF i, p`,
        [[crownId, input.rctPlanItemId], input.patientId, rows[0].tooth_code]);
      if (items.find((item) => item.id === crownId)?.category !== "crown") return refuse("bad_item");
      const rct = items.find((item) => item.id === input.rctPlanItemId);
      if (!rct || rct.category !== "rct" || rct.case_id !== rows[0].case_id) return refuse("bad_rct");
      const dependency = await addPlanItemDependencyInTransaction(client, {
        itemId: crownId, requiresItemId: rct.id, requirement: "completed",
        note: "تاج بعد علاج الجذور", actor: input.actor, actorRole: input.actorRole ?? null,
      });
      if (!dependency.ok) {
        if (dependency.reason !== "exists") return refuse("dependency_conflict");
        const { rows: existing } = await client.query<{ requirement: string }>(
          `SELECT requirement FROM plan_item_dependencies WHERE item_id = $1 AND requires_item_id = $2`, [crownId, rct.id]);
        if (existing[0]?.requirement !== "completed") return refuse("dependency_conflict");
      }
    }
    if (rows[0].crown_required === input.crownRequired && rows[0].crown_plan_item_id === crownId) {
      // A missing edge may have been repaired above; commit it, but do not rewrite
      // the unchanged clinical decision or its version/timestamp/audit.
      await client.query("COMMIT");
      return { ok: true, treatment: await oneView(client, input.treatmentId) };
    }
    await client.query(
      `UPDATE endo_treatments
          SET crown_required = $2, crown_plan_item_id = $3::int, version = version + 1, updated_at = NOW()
        WHERE id = $1`,
      [input.treatmentId, input.crownRequired, input.crownRequired ? input.crownPlanItemId : null]);
    await insertAuditRow(client, {
      action: "endo.crown", entity: "patient", entityId: input.patientId, entityLabel: toothName(rows[0].tooth_code),
      details: {
        النوبة: input.treatmentId, التاج_لازم: input.crownRequired ? "نعم" : "لا",
        بند_التاج: input.crownPlanItemId ?? "—", بند_علاج_الجذور: input.rctPlanItemId ?? "—",
      },
      actor: input.actor, actorRole: input.actorRole ?? null,
    });
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
  return { ok: true, treatment: await oneView(getPool(), input.treatmentId) };
}

export type { CanalSummary };
