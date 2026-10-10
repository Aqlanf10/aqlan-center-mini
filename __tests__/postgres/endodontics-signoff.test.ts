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
    `INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'علاج جذور ٣٦', '36', 'a') RETURNING id`, [patient]))[0].id;
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

  // A later visit-level coordinator must not replace the provider recorded on the endo record.
  const [{ id: coordinator }] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'Synthetic coordinator') RETURNING id`);
  await q(`UPDATE visits SET doctor_id = $2 WHERE id = $1`, [visit, coordinator]);
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
  expect(event?.caseTitle).toBe("علاج جذور ٣٦");
  expect(event?.specialties).toContain("rct");
  expect(event?.doctorName).toBe("د. أحمد");

  const [{ id: endoVisitId }] = await q<{ id: number }>(`SELECT id FROM endo_visits WHERE visit_id = $1`, [visit]);
  const added = await endo.addEndoAddendum({ actor: "dr", patientId: patient, treatmentId, endoVisitId, text: "تصحيح الطول", requestKey: crypto.randomUUID() });
  expect(added.ok).toBe(true);
  expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(0);
});


it("does not sign an empty structured row, stage-only, or suggested canal labels", async () => {
  for (const raw of [{}, { stage: "shaping" }, { canals: [{ label: "MB" }, { label: "ML" }] }]) {
    const visit = await newVisit(); const draft = checkEndoVisitDraft(raw);
    if (!draft.ok) throw new Error(draft.message);
    expect((await endo.saveEndoVisit({ actor: "dr", patientId: patient, treatmentId, visitId: visit,
      draft: draft.value, expectedVersion: null, actorPartyId: doctor })).ok).toBe(true);
    expect((await sign(visit)).reason).toBe("empty");
    expect((await q<{ signed_at: Date | null }>(`SELECT signed_at FROM visits WHERE id = $1`, [visit]))[0].signed_at).toBeNull();
  }
});

it("keeps existing billable procedures on the ordinary signing engine, without duplicate billing on retry", async () => {
  const visit = await newVisit();
  const [{ id: service }] = await q<{ id: number }>(
    `INSERT INTO services (name, category, price_minor) VALUES ('Synthetic filling alongside endo', 'filling', 12500) RETURNING id`);
  await q(`INSERT INTO visit_procedures (visit_id, service_id, tooth_code, quantity, unit_price_minor, doctor_id)
    VALUES ($1, $2, 46, 1, 12500, $3)`, [visit, service, doctor]);
  const draft = checkEndoVisitDraft({ pulpalDiagnosis: "pulp_necrosis" });
  if (!draft.ok) throw new Error(draft.message);
  expect((await endo.saveEndoVisit({ actor: "dr", patientId: patient, treatmentId, visitId: visit,
    draft: draft.value, expectedVersion: null, actorPartyId: doctor })).ok).toBe(true);
  const first = await sign(visit); const repeated = await sign(visit);
  expect(first.reason).toBeNull(); expect(first.invoiceId).not.toBeNull(); expect(first.duesMinor).toBe(12500);
  expect(repeated.invoiceId).toBe(first.invoiceId);
  expect(await q(`SELECT id FROM invoices WHERE id = $1`, [first.invoiceId])).toHaveLength(1);
  expect(await q(`SELECT service_id, doctor_id, total_minor::int FROM invoice_items WHERE invoice_id = $1`, [first.invoiceId]))
    .toEqual([{ service_id: service, doctor_id: doctor, total_minor: 12500 }]);
  expect(await q(`SELECT tooth_code FROM visit_procedures WHERE visit_id = $1`, [visit])).toEqual([{ tooth_code: 46 }]);
  const event = (await patientTimeline(patient, 50)).find((entry) => entry.key === `visit:${visit}`);
  expect(event?.title).toContain("Synthetic filling alongside endo"); expect(event?.title).toContain("علاج جذور سن 36");
  expect(event?.specialties).toEqual(expect.arrayContaining(["rct", "filling"]));
});
