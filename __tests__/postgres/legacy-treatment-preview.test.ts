import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest, type LegacyTreatmentRequest } from "../../lib/legacy-treatment";

/**
 * (LEGACY-FIX) معاينة «علاج بدأ قبل النظام» بقرار الحفظ نفسه — على PostgreSQL 18 معزولة وبيانات اصطناعية.
 * كان النموذج يستعير معاينة الفاتورة بسعرٍ مؤقت «1» فيرفضها فحص صلاحية السعر. المعاينة الآن:
 *  - تقرأ فقط (معاملة READ ONLY): لا خطة ولا حالة ولا رصيد ولا تدقيق؛
 *  - تقول ما سيقوله الحفظ: الحالة، وأثر الرصيد السابق، والرفض بسببه نفسه؛
 *  - ومدفوعٌ قديم أُدخل سندًا عامًّا يوقف التسجيل للمراجعة بدل خصمه مرتين.
 * وبعد التسجيل: تحصيلٌ حقيقي 20,000 ينزل بالرصيد إلى 160,000 ويبقى تحصيل اليوم 20,000 وحده.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const { createLegacyTreatment, previewLegacyTreatment, listLegacyTreatments } = await import("../../lib/legacy-treatment-db");
const { ensureSchema, getPool, resetPoolForTesting, openShift, recordPayment, patientWorkflow, createOrthoCase } = db;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const TODAY = "2026-10-06";
const services: Record<string, number> = {};

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  for (const [key, name, category] of [
    ["ortho", "تقويم ثابت", "ortho"], ["rct", "علاج عصب", "rct"], ["bridge", "جسر", "bridge"],
  ] as const) {
    services[key] = (await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`,
      [name, category]))[0].id;
  }
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

let seq = 0;
const newPatient = async () => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [`LGP-${++seq}`]))[0].id;

function request(body: Record<string, unknown>): LegacyTreatmentRequest {
  const parsed = parseLegacyTreatmentRequest({
    currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30", ...body,
  }, TODAY);
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
}
const preview = (patientId: number, body: Record<string, unknown>, canEditOpening = false) =>
  previewLegacyTreatment({ patientId, request: request(body), canEditOpening });
const create = (patientId: number, body: Record<string, unknown>, canEditOpening = false) => createLegacyTreatment({
  patientId, request: request(body), actor: canEditOpening ? "admin" : "reception", actorRole: canEditOpening ? "admin" : "reception",
  canEditOpening, templates: DEFAULT_SPECIALTY_TEMPLATES,
});
/** Every row a registration could write — the preview must leave all of them untouched. */
const footprint = async (patientId: number) => JSON.stringify(await q(`SELECT
    (SELECT COUNT(*) FROM treatment_plans WHERE patient_id = $1)::int AS plans,
    (SELECT COUNT(*) FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1)::int AS items,
    (SELECT COUNT(*) FROM clinical_cases WHERE patient_id = $1)::int AS cases,
    (SELECT COUNT(*) FROM legacy_treatment_agreements WHERE patient_id = $1)::int AS agreements,
    (SELECT COUNT(*) FROM patient_opening_balances WHERE patient_id = $1)::int AS openings,
    (SELECT COUNT(*) FROM patient_opening_balance_history WHERE patient_id = $1)::int AS opening_history,
    (SELECT COUNT(*) FROM payments WHERE patient_id = $1)::int AS payments,
    (SELECT COUNT(*) FROM invoices WHERE patient_id = $1)::int AS invoices,
    (SELECT COUNT(*) FROM audit_log)::int AS audit`, [patientId]));

describe("legacy registration preview uses the agreement data and the save decision", () => {
  it("previews a bridge 14–16 as a new marked case and a 180,000 opening, writes nothing, and the save then does exactly that", async () => {
    const patient = await newPatient();
    const body = { serviceId: services.bridge, toothCode: 14, episodeTeeth: [14, 15, 16] };
    const before = await footprint(patient);
    const seen = await preview(patient, body);
    expect(seen).toEqual({ ok: true, replayed: false, preview: {
      case: { mode: "new", id: null, title: expect.stringContaining("حالة بدأت قبل النظام"), options: [] },
      opening: { effect: "created", beforeMinor: null, afterMinor: 180_000, currency: "YER" },
    } });
    expect(await footprint(patient)).toBe(before);

    const saved = await create(patient, body);
    expect(saved).toMatchObject({ ok: true, caseCreated: true, agreement: { openingEffect: "created", remainingMinor: 180_000 } });
    // The same tooth episode is now refused by the preview and by the save, for the same reason.
    expect(await preview(patient, { ...body, toothCode: 15, episodeTeeth: [15] })).toEqual({ ok: false, reason: "duplicate_live" });
    expect(await create(patient, { ...body, toothCode: 15, episodeTeeth: [15] })).toEqual({ ok: false, reason: "duplicate_live" });
  });

  it("needs no invoice price: a catalog price far from the agreement is irrelevant to the preview", async () => {
    const patient = await newPatient();
    // Catalog price is 100,000; the historical agreement is 300,000. No price authority or discount reason applies.
    const seen = await preview(patient, { serviceId: services.rct, toothCode: 36 });
    expect(seen.ok).toBe(true);
  });

  it("offers a case choice when several open cases fit, and the save refuses until one is chosen", async () => {
    const patient = await newPatient();
    const cases = [];
    for (const title of ["عصب أول", "عصب ثانٍ"]) {
      cases.push((await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by, origin)
        VALUES ($1, 'endodontics', $2, '36', 'dr', 'clinical') RETURNING id`, [patient, title]))[0].id);
    }
    const seen = await preview(patient, { serviceId: services.rct, toothCode: 36 });
    expect(seen).toMatchObject({ ok: true, preview: { case: { mode: "choose", options: [{ id: cases[0] }, { id: cases[1] }] } } });
    expect(await create(patient, { serviceId: services.rct, toothCode: 36 })).toEqual({ ok: false, reason: "ambiguous_case" });
    expect(await preview(patient, { serviceId: services.rct, toothCode: 36, caseId: cases[1] }))
      .toMatchObject({ ok: true, preview: { case: { mode: "existing", id: cases[1] } } });
    expect(await create(patient, { serviceId: services.rct, toothCode: 36, caseId: cases[1] }))
      .toMatchObject({ ok: true, caseCreated: false, agreement: { caseId: cases[1] } });
  });

  it("previews the ortho bridge to an existing ortho case", async () => {
    const patient = await newPatient();
    const opened = await createOrthoCase({
      patientId: patient, appliance: "fixed_metal", arches: "both", slot: "022", bracketSystem: null,
      startDate: TODAY, plannedMonths: 18, planId: null, note: null, createdBy: "dr",
    });
    expect(opened).toBeTruthy();
    expect(await preview(patient, { serviceId: services.ortho, scope: "both" }))
      .toMatchObject({ ok: true, preview: { case: { mode: "bridge" } } });
  });

  it("states the opening effect per role: the reception may create, only the manager adds to an agreement-owned opening", async () => {
    const patient = await newPatient();
    expect(await create(patient, { serviceId: services.rct, toothCode: 36 })).toMatchObject({ ok: true });
    const second = { serviceId: services.rct, toothCode: 46, agreedAmount: "50000", previouslyPaidAmount: "10000" };
    expect(await preview(patient, second)).toEqual({ ok: false, reason: "opening_edit_forbidden" });
    expect(await preview(patient, second, true)).toMatchObject({ ok: true, preview: {
      opening: { effect: "increased", beforeMinor: 180_000, afterMinor: 220_000, currency: "YER" } } });
  });

  it("keeps original currencies apart: a SAR agreement opens a SAR balance and never touches YER", async () => {
    const patient = await newPatient();
    const body = { serviceId: services.rct, toothCode: 26, currency: "SAR", agreedAmount: "3000", previouslyPaidAmount: "1200" };
    expect(await preview(patient, body)).toMatchObject({ ok: true, preview: {
      opening: { effect: "created", afterMinor: 180_000, currency: "SAR" } } });
    expect(await create(patient, body)).toMatchObject({ ok: true, agreement: { currency: "SAR", remainingMinor: 180_000 } });
    expect(await q(`SELECT currency, amount_minor::int AS amount FROM patient_opening_balances WHERE patient_id = $1`, [patient]))
      .toEqual([{ currency: "SAR", amount: 180_000 }]);
  });
});

describe("ortho bridge scope (same rule as invoice-first)", () => {
  const orthoCase = async (patient: number, arches: string) => {
    await createOrthoCase({
      patientId: patient, appliance: "fixed_metal", arches: arches as "both", slot: "022", bracketSystem: null,
      startDate: TODAY, plannedMonths: 18, planId: null, note: null, createdBy: "dr",
    });
    return (await q<{ id: number }>(`SELECT id FROM ortho_cases WHERE patient_id = $1 ORDER BY id DESC LIMIT 1`, [patient]))[0].id;
  };

  it("refuses upper against a running lower case in preview and save, and rolls back every write", async () => {
    const patient = await newPatient();
    await orthoCase(patient, "lower");
    const before = await footprint(patient);
    expect(await preview(patient, { serviceId: services.ortho, scope: "upper" })).toEqual({ ok: false, reason: "ortho_scope_mismatch" });
    expect(await create(patient, { serviceId: services.ortho, scope: "upper" })).toEqual({ ok: false, reason: "ortho_scope_mismatch" });
    expect(await footprint(patient)).toBe(before);
  });

  it("fails closed on a blank or unknown recorded arch scope", async () => {
    for (const arches of ["", "unknown"]) {
      const patient = await newPatient();
      const id = await orthoCase(patient, "both");
      await q(`UPDATE ortho_cases SET arches = $2 WHERE id = $1`, [id, arches]);
      const before = await footprint(patient);
      expect(await preview(patient, { serviceId: services.ortho, scope: "both" })).toEqual({ ok: false, reason: "ortho_scope_mismatch" });
      expect(await create(patient, { serviceId: services.ortho, scope: "both" })).toEqual({ ok: false, reason: "ortho_scope_mismatch" });
      expect(await footprint(patient)).toBe(before);
    }
  });

  it("bridges exactly one matching case, once", async () => {
    const patient = await newPatient();
    const ortho = await orthoCase(patient, "upper");
    const saved = await create(patient, { serviceId: services.ortho, scope: "upper" });
    expect(saved).toMatchObject({ ok: true, caseCreated: true });
    if (!saved.ok) return;
    expect(await q(`SELECT ortho_case_id FROM clinical_cases WHERE id = $1`, [saved.agreement.caseId])).toEqual([{ ortho_case_id: ortho }]);
    expect(await q(`SELECT 1 FROM clinical_cases WHERE ortho_case_id = $1`, [ortho])).toHaveLength(1);
  });

  it("re-decides under the save's locks when the evidence changed after a successful preview", async () => {
    const patient = await newPatient();
    const id = await orthoCase(patient, "both");
    expect(await preview(patient, { serviceId: services.ortho, scope: "both" })).toMatchObject({ ok: true, preview: { case: { mode: "bridge" } } });
    await q(`UPDATE ortho_cases SET arches = 'lower' WHERE id = $1`, [id]);
    const before = await footprint(patient);
    expect(await create(patient, { serviceId: services.ortho, scope: "both" })).toEqual({ ok: false, reason: "ortho_scope_mismatch" });
    expect(await footprint(patient)).toBe(before);
  });

  it("cannot face two running ortho cases: the schema allows one open case per patient (the ambiguity refusal is defensive)", async () => {
    const patient = await newPatient();
    await orthoCase(patient, "both");
    await expect(q(`INSERT INTO ortho_cases (patient_id, appliance, arches, status, start_date, created_by)
      SELECT patient_id, appliance, arches, status, start_date, created_by FROM ortho_cases WHERE patient_id = $1`, [patient]))
      .rejects.toThrow(/ortho_cases_one_open/);
  });
});

describe("mixed clinic data: an old payment already entered as a general receipt", () => {
  it("refuses to record «paid before the system» on top of an unallocated receipt, in preview and save, and changes nothing", async () => {
    const patient = await newPatient();
    const paid = await recordPayment({
      patientId: patient, invoiceId: null, kind: "payment", amountMinor: 120_000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: "دفعة", createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    const before = await footprint(patient);
    const body = { serviceId: services.rct, toothCode: 11 };
    expect(await preview(patient, body)).toEqual({ ok: false, reason: "prior_receipts_review" });
    expect(await create(patient, body)).toEqual({ ok: false, reason: "prior_receipts_review" });
    expect(await footprint(patient)).toBe(before);
    // The receipt itself is not reclassified, reversed or redated.
    expect(await q(`SELECT amount_minor::int AS amount, invoice_id, plan_id, opening_currency, note FROM payments WHERE patient_id = $1`, [patient]))
      .toEqual([{ amount: 120_000, invoice_id: null, plan_id: null, opening_currency: null, note: "دفعة" }]);
    // Nothing claimed as paid before the system → no double count, so the agreement itself may be recorded.
    expect(await preview(patient, { ...body, previouslyPaidAmount: "0" })).toMatchObject({ ok: true });
  });

  it("does not block on a receipt that was fully refunded", async () => {
    const patient = await newPatient();
    const paid = await recordPayment({
      patientId: patient, invoiceId: null, kind: "payment", amountMinor: 10_000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    await q(`INSERT INTO payments (receipt_number, patient_id, shift_id, kind, amount_minor, currency, exchange_rate, base_amount_minor,
        base_currency, method, created_by, reversal_of_id)
      SELECT 'LGP-REFUND-' || id, patient_id, shift_id, 'refund', amount_minor, currency, exchange_rate, base_amount_minor, base_currency,
        method, 'cashier', id FROM payments WHERE patient_id = $1`, [patient]);
    expect(await preview(patient, { serviceId: services.rct, toothCode: 12 })).toMatchObject({ ok: true });
  });
});

describe("a real collection after registration", () => {
  it("20,000 collected today lowers 180,000 to 160,000, is today's only collection, and the historical facts stay as recorded", async () => {
    const patient = await newPatient();
    const saved = await create(patient, { serviceId: services.bridge, toothCode: 24, episodeTeeth: [24, 25, 26] });
    expect(saved.ok).toBe(true);
    const balance = async () => (await patientWorkflow(patient, TODAY)).financial?.byCurrency.YER.balanceMinor;
    expect(await balance()).toBe(180_000);

    const paid = await recordPayment({
      patientId: patient, invoiceId: null, openingCurrency: "YER", kind: "payment", amountMinor: 20_000, currency: "YER",
      baseCurrency: "YER", exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    expect(await balance()).toBe(160_000);
    expect(await q(`SELECT amount_minor::int AS amount, opening_currency FROM payments WHERE patient_id = $1`, [patient]))
      .toEqual([{ amount: 20_000, opening_currency: "YER" }]);
    // The opening principal and the historical agreement are not rewritten by the collection.
    expect(await q(`SELECT amount_minor::int AS amount FROM patient_opening_balances WHERE patient_id = $1`, [patient]))
      .toEqual([{ amount: 180_000 }]);
    expect((await listLegacyTreatments(patient))[0]).toMatchObject({
      agreedMinor: 300_000, previouslyPaidMinor: 120_000, remainingMinor: 180_000, status: "live",
    });
    expect(await q(`SELECT 1 FROM invoices WHERE patient_id = $1`, [patient])).toHaveLength(0);
  });
});
