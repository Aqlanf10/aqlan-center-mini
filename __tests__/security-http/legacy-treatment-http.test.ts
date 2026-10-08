import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (INV-LEGACY / LEGACY-FIX) «علاج بدأ قبل النظام» على التطبيق المبني وقاعدة معزولة اصطناعية.
 * استُعيد بعد سقوطه من تجميعٍ سابق، ومُكيَّف للعقد الحالي (لا افتراضات الإبطال القديمة):
 *  - التسجيل: 201 ثم إعادة 200 بالمفتاح نفسه، وجسمٌ آخر بالمفتاح 409، وتكرار العمل 409 — بلا فاتورة ولا سند ولا حركة صندوق؛
 *  - المعاينة الخاصة بالعلاج السابق بصلاحية الحفظ نفسها، ومعاينة الفاتورة العادية تبقى ترفض السعر الوهمي «1»؛
 *  - مدفوعٌ قديم أُدخل سندًا عامًّا يوقف التسجيل للمراجعة؛
 *  - تحصيلٌ حقيقي 20,000 بعد التسجيل ينزل بالرصيد إلى 160,000؛
 *  - الإبطال: العادي يرفض مع تحصيلات، والمصرّح به للمدير يتطلب معاينة حالية (رمزها مربوط بالنمط والأدلة) وسببًا، ويُدقَّق.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let rctService = 0;
let bridgeService = 0;
const stamp = Date.now();
const ARABIC = /[؀-ۿ]/;
let seq = 0;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const service = async (name: string, category: string) => (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 300000, TRUE, TRUE, $2) RETURNING id`,
    [`${name} ${stamp}`, category])).rows[0].id;
  rctService = await service("علاج عصب", "rct");
  bridgeService = await service("جسر", "bridge");
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'legacy-http', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
}, 120_000);
afterAll(async () => { await db?.end(); });

const newPatient = async () => (await db.query<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'علاج قبل النظام اصطناعي') RETURNING id`, [`LTH-${stamp}-${++seq}`])).rows[0].id;
type Who = "reception" | "admin" | "doctorA" | "cashier" | "accountant";
const draft = (body: Record<string, unknown>) => JSON.stringify({
  currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30", ...body,
});
const post = (who: Who, patient: number, body: Record<string, unknown>) =>
  authedMutation(`/api/patients/${patient}/legacy-treatments`, h.sessions[who], "POST", draft(body));
const preview = (who: Who, patient: number, body: Record<string, unknown>) =>
  authedMutation(`/api/patients/${patient}/legacy-treatments/preview`, h.sessions[who], "POST", draft(body));
const json = async (response: Response) => await response.json() as Record<string, unknown> & { message?: string };
const money = async (patient: number) => (await db.query<{ payments: number; invoices: number; opening: string | null }>(
  `SELECT (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
          (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
          (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER') AS opening`, [patient])).rows[0];
const balance = async (patient: number) => {
  const response = await authedGet(`/api/patients/${patient}/workflow`, h.sessions.admin);
  const body = await response.json() as { financial: { byCurrency: Record<string, { balanceMinor: number }> } };
  return body.financial.byCurrency.YER.balanceMinor;
};
const collect = (patient: number, amount: string) => authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify({
  patientId: patient, kind: "payment", currency: "YER", amount, method: "cash", invoiceId: null, planId: null, openingCurrency: "YER", note: null,
}), { "Idempotency-Key": `legacy-http-pay-${stamp}-${++seq}` });

describe("(INV-LEGACY) registration over HTTP", () => {
  it("reception registers 300,000 / 120,000: 201, remaining 180,000 as the only opening; replay 200; changed body 409; duplicate 409", async () => {
    const patient = await newPatient();
    const body = { serviceId: rctService, toothCode: 36, idempotencyKey: `legacy:http-${stamp}` };
    const created = await post("reception", patient, body);
    expect(created.status).toBe(201);
    const first = await json(created) as { agreement: { id: number; remainingMinor: number; openingEffect: string }; replayed: boolean };
    expect(first.agreement).toMatchObject({ remainingMinor: 180_000, openingEffect: "created" });
    expect(first.replayed).toBe(false);

    const replay = await post("reception", patient, body);
    expect(replay.status).toBe(200);
    expect(((await json(replay)) as { agreement: { id: number } }).agreement.id).toBe(first.agreement.id);
    const conflict = await post("reception", patient, { ...body, previouslyPaidAmount: "100000" });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).message).toContain("أُرسل سابقًا");

    const duplicate = await post("reception", patient, { serviceId: rctService, toothCode: 36 });
    expect(duplicate.status).toBe(409);
    const duplicatePayload = await json(duplicate);
    expect(duplicatePayload.message).toMatch(ARABIC);
    expect(JSON.stringify(duplicatePayload)).not.toMatch(/SELECT|legacy_treatment_agreements|stack|Error:/i);

    expect(await money(patient)).toEqual({ payments: 0, invoices: 0, opening: "180000" });
    const { rows: audit } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'legacy_treatment.create' AND entity_id = $1::text`, [patient]);
    expect(audit).toHaveLength(1);
  });

  it("validation is Arabic 400: paid > agreed, future cutoff, unknown currency, bad tooth, bad key, zero agreement, non-clinical service", async () => {
    const patient = await newPatient();
    const cases: Record<string, unknown>[] = [
      { serviceId: rctService, toothCode: 36, agreedAmount: "100", previouslyPaidAmount: "150" },
      { serviceId: rctService, toothCode: 36, historicalAsOf: "2999-01-01" },
      { serviceId: rctService, toothCode: 36, currency: "EUR" },
      { serviceId: rctService, toothCode: 19 },
      { serviceId: rctService, toothCode: 36, idempotencyKey: "bad key!" },
      { serviceId: "x" },
      { serviceId: rctService, toothCode: 36, agreedAmount: "0", previouslyPaidAmount: "0" },
    ];
    for (const body of cases) {
      for (const send of [post, preview]) {
        const response = await send("reception", patient, body);
        expect({ body, status: response.status }).toEqual({ body, status: 400 });
        expect((await json(response)).message).toMatch(ARABIC);
      }
    }
    const { rows: [consult] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 5000, TRUE, TRUE, 'consultation') RETURNING id`,
      [`كشف ${stamp}`]);
    const financial = await post("reception", patient, { serviceId: consult.id });
    expect(financial.status).toBe(400);
    expect((await json(financial)).message).toContain("خدمةً علاجية");
    expect(await money(patient)).toEqual({ payments: 0, invoices: 0, opening: null });
  });

  it("doctor, cashier and accountant cannot register or preview (403 Arabic, before the body); anonymous 401; unknown patient 404", async () => {
    const patient = await newPatient();
    for (const who of ["doctorA", "cashier", "accountant"] as const) {
      for (const path of ["legacy-treatments", "legacy-treatments/preview"]) {
        const response = await authedMutation(`/api/patients/${patient}/${path}`, h.sessions[who], "POST", "{}");
        expect({ who, path, status: response.status }).toEqual({ who, path, status: 403 });
        expect((await json(response)).message).toMatch(ARABIC);
      }
    }
    const anonymous = await authedMutation(`/api/patients/${patient}/legacy-treatments/preview`, { cookie: "" }, "POST", draft({ serviceId: rctService, toothCode: 36 }));
    expect(anonymous.status).toBe(401);
    const missing = await post("admin", 987654321, { serviceId: rctService, toothCode: 36 });
    expect(missing.status).toBe(404);
    expect((await json(missing)).message).toMatch(ARABIC);
    const missingPreview = await preview("admin", 987654321, { serviceId: rctService, toothCode: 36 });
    expect(missingPreview.status).toBe(404);
  });
});

describe("(LEGACY-FIX) the legacy preview and the unchanged invoice price authority", () => {
  it("previews from the agreement data with the save decision, writes nothing, and the invoice preview still refuses a placeholder price", async () => {
    const patient = await newPatient();
    const body = { serviceId: bridgeService, toothCode: 14, episodeTeeth: [14, 15, 16] };
    const seen = await preview("reception", patient, body);
    expect(seen.status).toBe(200);
    expect(await json(seen)).toMatchObject({ refusal: null, preview: {
      case: { mode: "new" }, opening: { effect: "created", afterMinor: 180_000, currency: "YER" } } });
    expect(await money(patient)).toEqual({ payments: 0, invoices: 0, opening: null });
    expect((await db.query(`SELECT 1 FROM treatment_plans WHERE patient_id = $1`, [patient])).rows).toHaveLength(0);

    // Root cause of the earlier 400: the form borrowed this invoice preview with price "1". It must keep refusing it.
    const borrowed = await authedMutation("/api/invoices/clinical-preview", h.sessions.reception, "POST", JSON.stringify({
      patientId: patient, currency: "YER", items: [{ serviceId: bridgeService, price: "1", quantity: 1, toothCode: 14, episodeTeeth: [14, 15, 16], caseId: "" }],
    }));
    expect(borrowed.status).toBe(400);
    expect((await json(borrowed)).message).toMatch(ARABIC);

    expect((await post("reception", patient, body)).status).toBe(201);
    const again = await preview("reception", patient, { serviceId: bridgeService, toothCode: 15, episodeTeeth: [15] });
    expect(again.status).toBe(200);
    expect(await json(again)).toMatchObject({ refusal: "duplicate_live", refusalMessage: expect.stringMatching(ARABIC) });
  });

  it("an old payment entered as a general receipt stops registration for review in preview and save; the receipt is untouched", async () => {
    const patient = await newPatient();
    const general = await authedMutation("/api/payments", h.sessions.reception, "POST", JSON.stringify({
      patientId: patient, kind: "payment", currency: "YER", amount: "120000", method: "cash", invoiceId: null, planId: null, openingCurrency: null, note: "دفعة قديمة",
    }), { "Idempotency-Key": `legacy-http-general-${stamp}` });
    expect(general.status).toBeLessThan(300);
    const body = { serviceId: rctService, toothCode: 21 };
    const seen = await preview("reception", patient, body);
    expect(await json(seen)).toMatchObject({ refusal: "prior_receipts_review", refusalMessage: expect.stringContaining("مراجعة") });
    const saved = await post("reception", patient, body);
    expect(saved.status).toBe(409);
    expect((await json(saved)).message).toContain("لا يصحّحها تلقائيًا");
    expect(await money(patient)).toEqual({ payments: 1, invoices: 0, opening: null });
    expect((await db.query(`SELECT note, opening_currency, invoice_id FROM payments WHERE patient_id = $1`, [patient])).rows)
      .toEqual([{ note: "دفعة قديمة", opening_currency: null, invoice_id: null }]);
  });

  it("a real 20,000 collection after registration lowers 180,000 to 160,000 and is the only receipt", async () => {
    const patient = await newPatient();
    expect((await post("reception", patient, { serviceId: rctService, toothCode: 46 })).status).toBe(201);
    expect(await balance(patient)).toBe(180_000);
    const paid = await collect(patient, "20000");
    expect(paid.status).toBeLessThan(300);
    expect(await balance(patient)).toBe(160_000);
    expect(await money(patient)).toEqual({ payments: 1, invoices: 0, opening: "180000" });
    const list = await json(await authedGet(`/api/patients/${patient}/legacy-treatments`, h.sessions.reception)) as {
      agreements: { agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number }[] };
    expect(list.agreements[0]).toMatchObject({ agreedMinor: 300_000, previouslyPaidMinor: 120_000, remainingMinor: 180_000 });
  });
});

describe("(INV-LEGACY) voiding: ordinary and manager-authorized, admin only", () => {
  const voidPath = (patient: number, agreement: number) => `/api/patients/${patient}/legacy-treatments/${agreement}/void`;
  const registered = async () => {
    const patient = await newPatient();
    const created = await post("reception", patient, { serviceId: rctService, toothCode: 47 });
    return { patient, agreement: ((await json(created)) as { agreement: { id: number } }).agreement.id };
  };

  it("ordinary void without collections: reception 403, short reason 400, admin 200 with audit and the opening removed; again 409", async () => {
    const { patient, agreement } = await registered();
    const byReception = await authedMutation(voidPath(patient, agreement), h.sessions.reception, "POST", JSON.stringify({ reason: "خطأ إدخال" }));
    expect(byReception.status).toBe(403);
    expect((await json(byReception)).message).toMatch(ARABIC);
    expect((await authedGet(voidPath(patient, agreement), h.sessions.reception)).status).toBe(403);
    const noReason = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST", JSON.stringify({ reason: "" }));
    expect(noReason.status).toBe(400);
    const voided = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST", JSON.stringify({ reason: "خطأ إدخال" }));
    expect(voided.status).toBe(200);
    expect(((await json(voided)) as { agreement: { status: string } }).agreement.status).toBe("void");
    expect((await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST", JSON.stringify({ reason: "مرة أخرى" }))).status).toBe(409);
    expect((await money(patient)).opening).toBeNull();
    const { rows: audit } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'legacy_treatment.void' AND entity_id = $1::text`, [patient]);
    expect(audit).toHaveLength(1);
    // History is kept: the void agreement is still listed with its reason.
    const list = await json(await authedGet(`/api/patients/${patient}/legacy-treatments`, h.sessions.admin)) as { agreements: { status: string }[] };
    expect(list.agreements.map((one) => one.status)).toEqual(["void"]);
  });

  it("with a collection: ordinary refuses; manager-authorized needs a current preview of the same mode, then voids within the principal bound", async () => {
    const { patient, agreement } = await registered();
    expect((await collect(patient, "20000")).status).toBeLessThan(300);

    const ordinary = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST", JSON.stringify({ reason: "خطأ إدخال" }));
    expect(ordinary.status).toBe(409);
    expect((await json(ordinary)).reason).toBe("opening_collected");

    const noPreview = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST",
      JSON.stringify({ reason: "قرار المدير", mode: "manager_authorized" }));
    expect(noPreview.status).toBe(400);
    expect((await json(noPreview)).reason).toBe("preview_required");

    // A second registration lifts the aggregate principal so the manager path can keep the collection covered.
    expect((await post("admin", patient, { serviceId: rctService, toothCode: 37, agreedAmount: "50000", previouslyPaidAmount: "0" })).status).toBe(201);
    const managerPreview = await json(await authedGet(`${voidPath(patient, agreement)}?mode=manager_authorized`, h.sessions.admin)) as {
      preview: { previewToken: string; canVoid: boolean; openingPrincipalBeforeMinor: number; openingPrincipalAfterMinor: number; netCollectionsMinor: number } };
    expect(managerPreview.preview).toMatchObject({ canVoid: true, openingPrincipalBeforeMinor: 230_000, openingPrincipalAfterMinor: 50_000, netCollectionsMinor: 20_000 });

    // A token read for the other mode is not an authorization for this one.
    const ordinaryPreview = await json(await authedGet(`${voidPath(patient, agreement)}?mode=ordinary`, h.sessions.admin)) as { preview: { previewToken: string } };
    const otherMode = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST",
      JSON.stringify({ reason: "قرار المدير", mode: "manager_authorized", previewToken: ordinaryPreview.preview.previewToken }));
    expect(otherMode.status).toBe(409);
    expect((await json(otherMode)).reason).toBe("preview_stale");

    // Evidence changes after the preview ⇒ the old token is stale.
    expect((await collect(patient, "1000")).status).toBeLessThan(300);
    const stale = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST",
      JSON.stringify({ reason: "قرار المدير", mode: "manager_authorized", previewToken: managerPreview.preview.previewToken }));
    expect(stale.status).toBe(409);
    expect((await json(stale)).reason).toBe("preview_stale");

    const fresh = await json(await authedGet(`${voidPath(patient, agreement)}?mode=manager_authorized`, h.sessions.admin)) as { preview: { previewToken: string } };
    const done = await authedMutation(voidPath(patient, agreement), h.sessions.admin, "POST",
      JSON.stringify({ reason: "قرار المدير", mode: "manager_authorized", previewToken: fresh.preview.previewToken }));
    expect(done.status).toBe(200);
    // No automatic refund, receipt correction or re-billing; collections stay as recorded.
    expect(await money(patient)).toEqual({ payments: 2, invoices: 0, opening: "50000" });
  });
});
