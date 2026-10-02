import { afterAll, beforeAll, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { checkEndoVisitDraft } from "../../lib/endodontics";

/**
 * (ENDO-3) التوقيع يعرف عمل علاج الجذور: سجلٌّ مهيكلٌ لزيارةٍ بلا إجراءٍ مسعَّر ولا تشخيصٍ نصّيّ يكفي للتوقيع؛
 * ثم يتجمّد، ويظهر في الخط الزمني، ويقبل ملحقًا. والزيارة الفارغة تبقى مرفوضة.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const endo = await import("../../lib/endodontics-db");
const { ensureSchema, getPool, resetPoolForTesting, signClinicalVisit, patientTimeline } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

let doctor = 0;
let patient = 0;
let treatmentId = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. أحمد') RETURNING id`))[0].id;
  patient = (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name) VALUES ('P-E3-1', 'مريض') RETURNING id`))[0].id;
  const caseId = (await q<{ id: number }>(
    `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'endodontics', 'علاج جذور ٣٦', 'a') RETURNING id`, [patient]))[0].id;
  const opened = await endo.openEndoTreatment({ actor: "dr", patientId: patient, caseId, toothCode: 36, kind: "initial" });
  if (!opened.ok) throw new Error("open");
  treatmentId = opened.treatment.id;
});

afterAll(async () => { await resetPoolForTesting(); });

const newVisit = async () => (await q<{ id: number }>(
  `INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('مريض', $1, $2) RETURNING id`, [patient, doctor]))[0].id;
const sign = (visitId: number) => signClinicalVisit({ visitId, baseCurrency: "YER", signedBy: "dr", signerDoctorPartyId: doctor });

it("an empty visit still cannot be signed", async () => {
  const visit = await newVisit();
  const result = await sign(visit);
  expect(result.reason).toBe("empty");
});

it("an endo-only visit signs; the record freezes, shows in the timeline, takes an addendum", async () => {
  const visit = await newVisit();
  const draft = checkEndoVisitDraft({
    stage: "shaping", pulpalDiagnosis: "pulp_necrosis", apicalDiagnosis: "chronic_apical_abscess",
    canals: [{ label: "MB", workingLengthMm: 20.5, referencePoint: "cusp_tip", measurementMethod: "both" }],
  });
  if (!draft.ok) throw new Error(draft.message);
  const saved = await endo.saveEndoVisit({
    actor: "dr", patientId: patient, treatmentId, visitId: visit, draft: draft.value, expectedVersion: null, actorPartyId: doctor,
  });
  expect(saved.ok).toBe(true);

  const result = await sign(visit);
  expect(result.reason).toBeNull();
  expect(result.visit?.status).toBe("signed");
  expect(result.invoiceId).toBeNull(); // no billable work: no invoice invented by the clinical record

  expect(await endo.saveEndoVisit({
    actor: "dr", patientId: patient, treatmentId, visitId: visit, draft: draft.value, expectedVersion: 1, actorPartyId: doctor,
  })).toEqual({ ok: false, reason: "visit_signed" });

  const timeline = await patientTimeline(patient, 50);
  const event = timeline.find((e) => e.key === `visit:${visit}`);
  expect(event?.title).toContain("علاج جذور سن 36");
  expect(event?.title).toContain("تشكيل القنوات");

  const [{ id: endoVisitId }] = await q<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id = $1`, [visit]);
  const added = await endo.addEndoAddendum({ actor: "dr", patientId: patient, treatmentId, endoVisitId, text: "تصحيح الطول" });
  expect(added.ok).toBe(true);
  expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(0);
});
