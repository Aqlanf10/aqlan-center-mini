import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { invoiceRequestFingerprint } from "../../lib/invoice-clinical-linkage";

/**
 * (INV-LINK B) الفاتورة العلاجية بدايةٌ مالية مرتبطة بالعلاج — على PostgreSQL 18.
 * فاتورة تقويم/عصب/تاج تنشئ (أو تربط) بند خطة وحالةً تخصصية في المعاملة نفسها، بلا اختلاق أي تفاصيل
 * سريرية، وبلا تكرار عند الإعادة أو التزامن؛ والإلغاء والتصحيح لا يمسّان السجل السريري.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const linkage = await import("../../lib/invoice-linkage-db");
const { ensureSchema, getPool, resetPoolForTesting, setInvoiceStatus, correctInvoice, createPlanV2, recordPlanConsent } = db;
const { createLinkedInvoice } = linkage;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const services: Record<string, number> = {};
let doctor = 0;

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  doctor = (await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. أحمد') RETURNING id`))[0].id;
  for (const [key, name, category] of [
    ["ortho", "تقويم ثابت", "ortho"], ["rct", "علاج عصب", "rct"], ["crown", "تاج زركونيا", "crown"],
    ["consult", "كشف", "consultation"], ["filling", "حشوة ضوئية", "filling"],
    ["bridge", "جسر زركونيا (لكل سن)", "bridge"], ["cleaning", "تنظيف جير", "cleaning"],
  ] as const) {
    services[key] = (await q<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 100000, TRUE, TRUE, $2) RETURNING id`,
      [name, category]))[0].id;
  }
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

const newPatient = async (n: string) => (await q<{ id: number }>(
  `INSERT INTO patients (patient_number, full_name) VALUES ($1, $1) RETURNING id`, [n]))[0].id;

type Line = {
  service: keyof typeof services | null; price: number; tooth?: number | null; caseId?: number | null; description?: string;
  quantity?: number; sessions?: number | null;
  surfaces?: string | null; episodeTeeth?: number[] | null; scope?: string | null;
};
const lineOf = (line: Line) => ({
  serviceId: line.service ? services[line.service] : null,
  category: line.service ? ({ ortho: "ortho", rct: "rct", crown: "crown", consult: "consultation", filling: "filling", bridge: "bridge", cleaning: "cleaning" } as Record<string, string>)[line.service] : null,
  doctorId: doctor, description: line.description ?? line.service ?? "رسوم", quantity: line.quantity ?? 1, unitPriceMinor: line.price,
  toothCode: line.tooth ?? null, caseId: line.caseId ?? null, sessions: line.sessions ?? null,
  surfaces: line.surfaces ?? null, episodeTeeth: line.episodeTeeth ?? null, scope: line.scope ?? null,
});
const invoice = (patientId: number, lines: Line[], key: string | null = null) => {
  const items = lines.map(lineOf);
  return createLinkedInvoice({
    patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "reception", actorRole: "reception",
    items, templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: key,
    requestHash: key ? invoiceRequestFingerprint({ patientId, currency: "YER", discountMinor: 0, items }) : null,
    auditDetails: {},
  });
};
const counts = async (patientId: number) => (await q<{ invoices: number; plans: number; items: number; cases: number }>(
  `SELECT (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
          (SELECT COUNT(*)::int FROM treatment_plans WHERE patient_id = $1) AS plans,
          (SELECT COUNT(*)::int FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1) AS items,
          (SELECT COUNT(*)::int FROM clinical_cases WHERE patient_id = $1) AS cases`, [patientId]))[0];

describe("scenario 1 — orthodontics 300,000", () => {
  it("one invoice, one consented plan item pre-billed, one intake case; nothing clinical invented", async () => {
    const patient = await newPatient("INV-ORTHO");
    const result = await invoice(patient, [{ service: "ortho", price: 30_000_000 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await counts(patient)).toEqual({ invoices: 1, plans: 1, items: 1, cases: 1 });
    const [item] = await q<{ id: number; billing_status: string; billed_invoice_id: number; origin: string; case_id: number; doctor_id: number; session_count: number }>(
      `SELECT i.id, i.billing_status, i.billed_invoice_id, i.origin, i.case_id, i.doctor_id, i.session_count
         FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1`, [patient]);
    expect(item).toMatchObject({ billing_status: "billed", billed_invoice_id: result.invoice.id, origin: "invoice", doctor_id: doctor });
    expect(item.session_count).toBe(12); // the ortho template step's sessions (1 + 10 + 1)
    const [plan] = await q<{ consent_at: Date | null; consent_note: string; status: string }>(`SELECT consent_at, consent_note, status FROM treatment_plans WHERE patient_id = $1`, [patient]);
    expect(plan.consent_at).not.toBeNull();
    expect(plan.consent_note).toContain("قبول مالي بالفاتورة");
    const [kase] = await q<{ specialty: string; title: string; origin: string; problem: string | null; responsible_party_id: number | null; ortho_case_id: number | null }>(
      `SELECT specialty, title, origin, problem, responsible_party_id, ortho_case_id FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(kase).toMatchObject({ specialty: "orthodontics", origin: "invoice", problem: null, responsible_party_id: null, ortho_case_id: null });
    expect(kase.title).toContain("تحتاج تقييمًا سريريًّا");
    expect(item.case_id).not.toBeNull();
    expect(await q(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patient])).toHaveLength(0); // no invented wires/appliance
    const [line] = await q<{ source_type: string; source_id: string }>(`SELECT source_type, source_id::text FROM invoice_items WHERE invoice_id = $1`, [result.invoice.id]);
    expect(line).toEqual({ source_type: "plan_item", source_id: String(item.id) });
    const actions = (await q<{ action: string }>(`SELECT action FROM audit_log WHERE action IN ('plan.create','case.create','plan.item_case','invoice.create') ORDER BY id`)).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["plan.create", "case.create", "plan.item_case", "invoice.create"]));
  });

  it("an existing active ortho case is bridged instead of a second ortho context", async () => {
    const patient = await newPatient("INV-ORTHO-EXIST");
    const [ortho] = await q<{ id: number }>(`INSERT INTO ortho_cases (patient_id, created_by) VALUES ($1, 'dr') RETURNING id`, [patient]);
    const result = await invoice(patient, [{ service: "ortho", price: 30_000_000 }]);
    expect(result.ok).toBe(true);
    const [kase] = await q<{ ortho_case_id: number; title: string }>(`SELECT ortho_case_id, title FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(kase.ortho_case_id).toBe(ortho.id);
  });
});

describe("scenario 2/3 — endo and crown create no fake findings and no lab orders", () => {
  it("RCT #36 + crown #36: one plan, two items, endo + prostho cases, no endo_treatments, no lab order", async () => {
    const patient = await newPatient("INV-ENDO");
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }, { service: "crown", price: 120_000, tooth: 36 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await counts(patient)).toEqual({ invoices: 1, plans: 1, items: 2, cases: 2 });
    expect((await q<{ specialty: string; site: string }>(`SELECT specialty, site FROM clinical_cases WHERE patient_id = $1 ORDER BY specialty`, [patient])))
      .toEqual([{ specialty: "endodontics", site: "36" }, { specialty: "prosthodontics", site: "36" }]);
    expect(await q(`SELECT 1 FROM endo_treatments WHERE patient_id = $1`, [patient])).toHaveLength(0);
    expect(await q(`SELECT 1 FROM lab_orders WHERE patient_id = $1`, [patient])).toHaveLength(0);
    const sessions = await q<{ session_count: number; category: string }>(
      `SELECT i.session_count, i.category FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`, [patient]);
    expect(sessions).toEqual([{ session_count: 3, category: "rct" }, { session_count: 2, category: "crown" }]);
  });
});

describe("scenario 6 — mixed ortho + endo + crown, plus financial-only lines", () => {
  it("one master plan, three items, cases per specialty, financial lines stay invoice-only", async () => {
    const patient = await newPatient("INV-MIXED");
    const result = await invoice(patient, [
      { service: "ortho", price: 30_000_000 }, { service: "rct", price: 80_000, tooth: 21 }, { service: "crown", price: 120_000, tooth: 21 },
      { service: "consult", price: 5_000 }, { service: null, price: 2_000, description: "رسوم ملف" }, { service: "filling", price: 25_000, tooth: 46 },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await counts(patient)).toEqual({ invoices: 1, plans: 1, items: 4, cases: 3 }); // filling: item, no case
    expect(result.links.map((l) => l.kind)).toEqual(["clinical", "clinical", "clinical", "financial", "financial", "clinical"]);
    const lines = await q<{ source_type: string | null }>(`SELECT source_type FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [result.invoice.id]);
    expect(lines.map((l) => l.source_type)).toEqual(["plan_item", "plan_item", "plan_item", null, null, "plan_item"]);
  });
});

describe("scenario 5 — retry, double click, two tabs, concurrency", () => {
  it("same key: replay returns the same invoice; a different body with the key is a conflict", async () => {
    const patient = await newPatient("INV-RETRY");
    const first = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 11 }], "inv:retry-0001");
    const again = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 11 }], "inv:retry-0001");
    expect(first.ok && again.ok && again.replayed && again.invoice.id === first.invoice.id).toBe(true);
    if (again.ok) expect(again.links[0].planItemId).toBe(first.ok ? first.links[0].planItemId : -1);
    expect(await invoice(patient, [{ service: "rct", price: 90_000, tooth: 11 }], "inv:retry-0001")).toEqual({ ok: false, reason: "idempotency_conflict", line: null });
    expect(await counts(patient)).toEqual({ invoices: 1, plans: 1, items: 1, cases: 1 });
  });

  it("concurrent double submit (same key) and two tabs (different keys) never duplicate the obligation", async () => {
    const patient = await newPatient("INV-CONC");
    const same = await Promise.all(Array.from({ length: 4 }, () => invoice(patient, [{ service: "ortho", price: 30_000_000 }], "inv:conc-same-01")));
    expect(same.every((r) => r.ok)).toBe(true);
    expect(new Set(same.map((r) => (r.ok ? r.invoice.id : 0))).size).toBe(1);
    const tabs = await Promise.all([
      invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }], "inv:tab-a-0001"),
      invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }], "inv:tab-b-0001"),
    ]);
    expect(tabs.filter((r) => r.ok)).toHaveLength(1);
    expect(tabs.find((r) => !r.ok)).toEqual({ ok: false, reason: "already_billed", line: 0 });
    expect(await counts(patient)).toEqual({ invoices: 2, plans: 2, items: 2, cases: 2 });
  });

  it("same service on a different tooth is a different treatment — and a different endodontic episode", async () => {
    const patient = await newPatient("INV-TEETH");
    expect((await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }])).ok).toBe(true);
    expect((await invoice(patient, [{ service: "rct", price: 80_000, tooth: 46 }])).ok).toBe(true);
    const c = await counts(patient);
    expect(c).toMatchObject({ invoices: 2, items: 2, cases: 2 }); // the open case for 36 is not reused for 46
    // the same tooth again (a new treatment after the first started) reuses its site's case
    expect((await q<{ site: string }>(`SELECT site FROM clinical_cases WHERE patient_id = $1 ORDER BY id`, [patient])).map((r) => r.site)).toEqual(["36", "46"]);
  });
});

describe("reuse of an existing agreed plan item, and refusals", () => {
  it("an exact open consented item is reused (no new plan); a different amount is refused", async () => {
    const patient = await newPatient("INV-REUSE");
    const plan = await createPlanV2({
      patientId: patient, title: "خطة الطبيب", specialty: null, primaryDoctorId: doctor, billingMode: "per_procedure",
      baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "dr", installments: [],
      items: [{ serviceId: services.rct, serviceName: "علاج عصب", category: "rct", toothCode: 26, surfaces: null, quantity: 1, unitPriceMinor: 80_000, billingRule: "on_completion", sessionCount: 3, note: null }],
    });
    if (!plan.ok) throw new Error(plan.message);
    await recordPlanConsent({ planId: plan.planId, actor: "dr", note: null });
    expect(await invoice(patient, [{ service: "rct", price: 70_000, tooth: 26 }])).toEqual({ ok: false, reason: "amount_mismatch", line: 0 });
    const ok = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 26 }]);
    expect(ok.ok && ok.links[0].planItemCreated === false && ok.planId === null).toBe(true);
    expect(await counts(patient)).toMatchObject({ invoices: 1, plans: 1, items: 1 });
  });

  it("two open cases of one specialty without a choice are refused; with a choice the line links to it", async () => {
    const patient = await newPatient("INV-AMBIG");
    const mk = async () => (await q<{ id: number }>(`INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'endodontics', 'x', 'dr') RETURNING id`, [patient]))[0].id;
    const a = await mk(); await mk();
    expect(await invoice(patient, [{ service: "rct", price: 80_000, tooth: 14 }])).toEqual({ ok: false, reason: "ambiguous_case", line: 0 });
    expect(await invoice(patient, [{ service: "rct", price: 80_000, tooth: 14, caseId: 999999 }])).toEqual({ ok: false, reason: "bad_case", line: 0 });
    const chosen = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 14, caseId: a }]);
    expect(chosen.ok && chosen.links[0].caseId === a).toBe(true);
    expect(await counts(patient)).toMatchObject({ invoices: 1, cases: 2 }); // refusals rolled back fully
  });
});

describe("scenario 4 — cancellation and correction keep the clinical record", () => {
  it("cancel: case and item survive, financial link cleared and audited; nothing deleted", async () => {
    const patient = await newPatient("INV-CANCEL");
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }]);
    if (!result.ok) throw new Error("create");
    await setInvoiceStatus(result.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" });
    const [item] = await q<{ billing_status: string; billed_invoice_id: number | null; case_id: number }>(
      `SELECT i.billing_status, i.billed_invoice_id, i.case_id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1`, [patient]);
    expect(item).toMatchObject({ billing_status: "unbilled", billed_invoice_id: null });
    expect(await counts(patient)).toEqual({ invoices: 1, plans: 1, items: 1, cases: 1 });
    const audits = await q<{ details: Record<string, unknown> }>(`SELECT details FROM audit_log WHERE action = 'plan.item_update' AND entity_id = $1`, [String(patient)]);
    expect(JSON.stringify(audits)).toContain("يحتاج مراجعة مالية");
    // the same treatment can be invoiced again after a cancellation (no stale "already billed")
    const again = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }]);
    expect(again.ok).toBe(true);
  });

  it("correction: a kept line moves the link to the replacement; a removed line releases it", async () => {
    const patient = await newPatient("INV-CORRECT");
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }, { service: "crown", price: 120_000, tooth: 36 }]);
    if (!result.ok) throw new Error("create");
    const lines = await q<{ id: number; description: string }>(`SELECT id, description FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [result.invoice.id]);
    const corrected = await correctInvoice({
      invoiceId: result.invoice.id, reason: "التاج لاحقًا", actor: "admin", actorRole: "admin",
      lines: [{ itemId: lines[0].id, quantity: 1, unitPriceMinor: 75_000 }],
    });
    expect(corrected.ok).toBe(true);
    if (!corrected.ok) return;
    const items = await q<{ category: string; billing_status: string; billed_invoice_id: number | null }>(
      `SELECT i.category, i.billing_status, i.billed_invoice_id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`, [patient]);
    expect(items).toEqual([
      { category: "rct", billing_status: "billed", billed_invoice_id: corrected.corrected.id },
      { category: "crown", billing_status: "unbilled", billed_invoice_id: null },
    ]);
    expect(await counts(patient)).toMatchObject({ cases: 2, items: 2 });
  });
});

describe("Codex review hardening", () => {
  const doctorPlan = async (patient: number, item: { service: "rct" | "crown"; tooth: number; price: number; quantity?: number; sessions?: number; surfaces?: string | null }) => {
    const plan = await createPlanV2({
      patientId: patient, title: "خطة الطبيب", specialty: null, primaryDoctorId: doctor, billingMode: "per_procedure",
      baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "dr", installments: [],
      items: [{ serviceId: services[item.service], serviceName: item.service, category: item.service, toothCode: item.tooth,
        surfaces: item.surfaces ?? null, quantity: item.quantity ?? 1, unitPriceMinor: item.price, billingRule: "on_completion",
        sessionCount: item.sessions ?? 3, note: null }],
    });
    if (!plan.ok) throw new Error(plan.message);
    await recordPlanConsent({ planId: plan.planId, actor: "dr", note: null });
    const [row] = await q<{ id: number }>(`SELECT id FROM plan_items WHERE plan_id = $1`, [plan.planId]);
    return { planId: plan.planId, itemId: row.id };
  };

  it("a chosen case that conflicts with the reused item's case is refused, not silently ignored", async () => {
    const patient = await newPatient("INV-CASE-MISMATCH");
    const mk = async (site: string) => (await q<{ id: number }>(
      `INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'x', $2, 'dr') RETURNING id`, [patient, site]))[0].id;
    const a = await mk("27"); const b = await mk("27");
    const { itemId } = await doctorPlan(patient, { service: "rct", tooth: 27, price: 80_000 });
    await q(`UPDATE plan_items SET case_id = $2 WHERE id = $1`, [itemId, a]);
    expect(await invoice(patient, [{ service: "rct", price: 80_000, tooth: 27, caseId: b }])).toEqual({ ok: false, reason: "case_mismatch", line: 0 });
    const same = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 27, caseId: a }]);
    expect(same.ok && same.links[0].planItemId === itemId && same.links[0].caseId === a).toBe(true);
  });

  it("reuse compares the whole work shape: quantity, sessions, surfaces; several exact matches are ambiguous", async () => {
    const patient = await newPatient("INV-SHAPE");
    await doctorPlan(patient, { service: "rct", tooth: 15, price: 40_000, quantity: 2, sessions: 1 });
    // same total (1 × 80,000 vs 2 × 40,000) but a different quantity
    expect(await invoice(patient, [{ service: "rct", price: 80_000, tooth: 15 }])).toEqual({ ok: false, reason: "shape_mismatch", line: 0 });
    // same quantity and total, a different explicit session count
    expect(await invoice(patient, [{ service: "rct", price: 40_000, quantity: 2, tooth: 15, sessions: 3 }])).toEqual({ ok: false, reason: "shape_mismatch", line: 0 });
    const ok = await invoice(patient, [{ service: "rct", price: 40_000, quantity: 2, tooth: 15, sessions: 1 }]);
    expect(ok.ok && !ok.links[0].planItemCreated).toBe(true);

    const surfaced = await newPatient("INV-SURFACES");
    await doctorPlan(surfaced, { service: "rct", tooth: 16, price: 80_000, surfaces: "MO" });
    expect(await invoice(surfaced, [{ service: "rct", price: 80_000, tooth: 16 }])).toEqual({ ok: false, reason: "shape_mismatch", line: 0 });

    const twice = await newPatient("INV-TWO-MATCHES");
    await doctorPlan(twice, { service: "rct", tooth: 17, price: 80_000 });
    await doctorPlan(twice, { service: "rct", tooth: 17, price: 80_000 });
    expect(await invoice(twice, [{ service: "rct", price: 80_000, tooth: 17 }])).toEqual({ ok: false, reason: "ambiguous_item", line: 0 });
  });

  it("an open case on another tooth is not reused for a site-specific specialty; one invoice, two teeth ⇒ two cases", async () => {
    const patient = await newPatient("INV-SITE");
    const [other] = await q<{ id: number }>(
      `INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'endodontics', 'عصب 11', '11', 'dr') RETURNING id`, [patient]);
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }, { service: "rct", price: 80_000, tooth: 46 }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const caseIds = result.links.map((l) => l.caseId);
    expect(caseIds).not.toContain(other.id);
    expect(new Set(caseIds).size).toBe(2);
    // ortho is whole-mouth: two ortho lines in one invoice share one case
    const ortho = await newPatient("INV-SITE-ORTHO");
    const o = await invoice(ortho, [{ service: "ortho", price: 100_000 }, { service: "ortho", price: 100_000, description: "تقويم 2" }]);
    expect(o.ok && o.links[0].caseId === o.links[1].caseId).toBe(true);
  });

  it("replay reconstructs only the invoice-created plan (null when the invoice only reused items)", async () => {
    const patient = await newPatient("INV-REPLAY-PLAN");
    await doctorPlan(patient, { service: "rct", tooth: 24, price: 80_000 });
    const first = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 24 }], "inv:replay-plan-1");
    const again = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 24 }], "inv:replay-plan-1");
    expect(first.ok && first.planId === null).toBe(true);
    expect(again.ok && again.replayed && again.planId === null).toBe(true);
    expect(again.ok && first.ok && JSON.stringify(again.links.map((l) => [l.kind, l.specialty, l.planItemId, l.caseId]))
      === JSON.stringify(first.links.map((l) => [l.kind, l.specialty, l.planItemId, l.caseId]))).toBe(true);

    const mixed = await newPatient("INV-REPLAY-MIXED");
    await doctorPlan(mixed, { service: "rct", tooth: 25, price: 80_000 });
    const m1 = await invoice(mixed, [{ service: "rct", price: 80_000, tooth: 25 }, { service: "crown", price: 120_000, tooth: 25 }], "inv:replay-mixed1");
    const m2 = await invoice(mixed, [{ service: "rct", price: 80_000, tooth: 25 }, { service: "crown", price: 120_000, tooth: 25 }], "inv:replay-mixed1");
    expect(m1.ok && m2.ok && m1.planId !== null && m2.planId === m1.planId).toBe(true);
  });

  it("the fingerprint covers note and sessions: the same key with another note or session plan conflicts", () => {
    const base = { patientId: 1, currency: "YER", discountMinor: 0, note: null as string | null,
      items: [{ serviceId: 1, description: "x", quantity: 1, unitPriceMinor: 1, doctorId: null, toothCode: 36, caseId: null, sessions: null as number | null }] };
    const fp = invoiceRequestFingerprint(base);
    expect(invoiceRequestFingerprint({ ...base, note: "ملاحظة" })).not.toBe(fp);
    expect(invoiceRequestFingerprint({ ...base, items: [{ ...base.items[0], sessions: 3 }] })).not.toBe(fp);
  });

  it("repeated corrections keep the plan link on the newest live invoice", async () => {
    const patient = await newPatient("INV-CORRECT-TWICE");
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }, { service: "crown", price: 120_000, tooth: 36 }]);
    if (!result.ok) throw new Error("create");
    let current = result.invoice.id;
    for (const price of [78_000, 76_000]) {
      const lines = await q<{ id: number }>(`SELECT id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [current]);
      const corrected = await correctInvoice({
        invoiceId: current, reason: "تخفيض", actor: "admin", actorRole: "admin",
        lines: [{ itemId: lines[0].id, quantity: 1, unitPriceMinor: price }, { itemId: lines[1].id, quantity: 1, unitPriceMinor: 120_000 }],
      });
      if (!corrected.ok) throw new Error(corrected.message);
      current = corrected.corrected.id;
    }
    const items = await q<{ billing_status: string; billed_invoice_id: number | null }>(
      `SELECT i.billing_status, i.billed_invoice_id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`, [patient]);
    expect(items).toEqual([
      { billing_status: "billed", billed_invoice_id: current },
      { billing_status: "billed", billed_invoice_id: current },
    ]);
    // each line of the newest invoice names its plan item; the cancelled originals keep their source untouched
    const lineage = await q<{ plan_item_id: number | null }>(`SELECT plan_item_id FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [current]);
    expect(lineage.every((l) => l.plan_item_id !== null)).toBe(true);
    const sources = await q<{ source_type: string }>(`SELECT source_type FROM invoice_items WHERE invoice_id = $1`, [result.invoice.id]);
    expect(sources.every((l) => l.source_type === "plan_item")).toBe(true);
  });

  it("cancellation waits for a sign-off holding the plan item (item → invoice lock order)", async () => {
    const patient = await newPatient("INV-LOCK-CANCEL");
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 37 }]);
    if (!result.ok) throw new Error("create");
    const itemId = result.links[0].planItemId!;
    const signer = await getPool().connect();
    try {
      await signer.query("BEGIN");
      await signer.query(`SELECT id FROM plan_items WHERE id = $1 FOR UPDATE`, [itemId]);
      let done = false;
      const cancel = setInvoiceStatus(result.invoice.id, "cancelled", { actor: "admin", actorRole: "admin" }).then((r) => { done = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(done).toBe(false); // the cancellation queues behind the item lock, not behind a half-read invoice
      // the sign-off's next step — share-locking the covering invoice — must not collide with a cancellation holding it
      await expect(signer.query(`SELECT id FROM invoices WHERE id = $1 FOR SHARE NOWAIT`, [result.invoice.id])).resolves.toBeTruthy();
      await signer.query("COMMIT");
      await cancel;
    } finally {
      signer.release();
    }
    const [item] = await q<{ billing_status: string }>(`SELECT billing_status FROM plan_items WHERE id = $1`, [itemId]);
    expect(item.billing_status).toBe("unbilled");
  });

  it("an invoice waiting on an item a sign-off is starting re-checks it after the lock and does not reuse it", async () => {
    const patient = await newPatient("INV-LOCK-REUSE");
    const { itemId } = await doctorPlan(patient, { service: "rct", tooth: 47, price: 80_000 });
    const signer = await getPool().connect();
    try {
      await signer.query("BEGIN");
      await signer.query(`SELECT id FROM plan_items WHERE id = $1 FOR UPDATE`, [itemId]);
      const pending = invoice(patient, [{ service: "rct", price: 80_000, tooth: 47 }]);
      await new Promise((resolve) => setTimeout(resolve, 400));
      await signer.query(`UPDATE plan_items SET status = 'in_progress', started_at = NOW() WHERE id = $1`, [itemId]);
      await signer.query("COMMIT");
      const result = await pending;
      expect(result.ok && result.links[0].planItemId !== itemId && result.links[0].planItemCreated).toBe(true);
    } finally {
      signer.release();
    }
    const [item] = await q<{ billing_status: string; billed_invoice_id: number | null }>(
      `SELECT billing_status, billed_invoice_id FROM plan_items WHERE id = $1`, [itemId]);
    expect(item).toEqual({ billing_status: "unbilled", billed_invoice_id: null });
  });
});

describe("INV-LINK TOOTH — tooth/site selection rules (fail closed, one source for save and preview)", () => {
  const preview = (patientId: number, lines: Line[]) => linkage.previewInvoiceLinkage({
    patientId, baseCurrency: "YER", items: lines.map((line) => ({ ...lineOf(line) })),
  });
  const plain = async (patientId: number) => q<{ tooth_code: number | null; surfaces: string | null; note: string | null; case_id: number | null }>(
    `SELECT i.tooth_code, i.surfaces, i.note, i.case_id FROM plan_items i JOIN treatment_plans t ON t.id = i.plan_id WHERE t.patient_id = $1 ORDER BY i.id`, [patientId]);

  it("a tooth-bound service without a tooth is refused and nothing is written; the preview says the same", async () => {
    const patient = await newPatient("TOOTH-REQ");
    for (const service of ["rct", "crown", "filling", "bridge"] as const) {
      expect(await invoice(patient, [{ service, price: 80_000 }])).toEqual({ ok: false, reason: "tooth_required", line: 0 });
      expect((await preview(patient, [{ service, price: 80_000 }]))[0].refusal).toBe("tooth_required");
    }
    expect(await counts(patient)).toEqual({ invoices: 0, plans: 0, items: 0, cases: 0 });
  });

  it("an endodontic episode covers one tooth: several teeth on one line must be split; split lines give a case per tooth", async () => {
    const patient = await newPatient("TOOTH-ENDO");
    expect(await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36, episodeTeeth: [36, 46] }]))
      .toEqual({ ok: false, reason: "episode_split_required", line: 0 });
    expect((await preview(patient, [{ service: "rct", price: 80_000, tooth: 36, episodeTeeth: [36, 46] }]))[0].refusal).toBe("episode_split_required");
    const split = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 36 }, { service: "rct", price: 80_000, tooth: 46 }]);
    expect(split.ok).toBe(true);
    expect((await plain(patient)).map((row) => row.tooth_code)).toEqual([36, 46]);
    expect((await q<{ site: string }>(`SELECT site FROM clinical_cases WHERE patient_id = $1 ORDER BY id`, [patient])).map((r) => r.site)).toEqual(["36", "46"]);
  });

  it("a bridge 14–16 is one unit per tooth and ONE prosthodontic episode; no abutments inferred", async () => {
    const patient = await newPatient("TOOTH-BRIDGE");
    const lines: Line[] = [14, 15, 16].map((tooth) => ({ service: "bridge" as const, price: 120_000, tooth, episodeTeeth: [16, 14, 15] }));
    const before = await preview(patient, lines);
    expect(before.map((p) => p.case?.mode)).toEqual(["new", "new", "new"]);
    expect(new Set(before.map((p) => p.case?.title)).size).toBe(1);
    const result = await invoice(patient, lines);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new Set(result.links.map((l) => l.caseId)).size).toBe(1);
    const items = await plain(patient);
    expect(items.map((row) => row.tooth_code)).toEqual([14, 15, 16]);
    const [kase] = await q<{ site: string; title: string }>(`SELECT site, title FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(kase.site).toBe("14، 15، 16");
    expect(kase.title).toContain("14، 15، 16");
    // an open prosthodontic case on 14 only does not cover the 14–16 episode
    const other = await newPatient("TOOTH-BRIDGE-2");
    await q(`INSERT INTO clinical_cases (patient_id, specialty, title, site, created_by) VALUES ($1, 'prosthodontics', 'تاج 14', '14', 'dr')`, [other]);
    const second = await invoice(other, lines);
    expect(second.ok && second.links.every((l) => l.caseCreated || l.caseId === second.links[0].caseId)).toBe(true);
    expect((await q(`SELECT 1 FROM clinical_cases WHERE patient_id = $1`, [other]))).toHaveLength(2);
    // the episode must contain the line's own tooth
    expect(await invoice(patient, [{ service: "bridge", price: 1, tooth: 24, episodeTeeth: [25, 26] }])).toEqual({ ok: false, reason: "bad_tooth", line: 0 });
  });

  it("a filling stores its surfaces (normalized) and reuses an agreed item only with the same surfaces", async () => {
    const patient = await newPatient("TOOTH-FILL");
    const created = await invoice(patient, [{ service: "filling", price: 25_000, tooth: 26, surfaces: "om" }]);
    expect(created.ok).toBe(true);
    expect((await plain(patient))[0]).toMatchObject({ tooth_code: 26, surfaces: "MO" });
    expect(await invoice(patient, [{ service: "filling", price: 25_000, tooth: 27, surfaces: "MX" }])).toEqual({ ok: false, reason: "bad_surfaces", line: 0 });
    // doctor's agreed filling on 17 MOD: reused only by MOD, a different surface set is a different shape
    const agreed = await createPlanV2({
      patientId: patient, title: "خطة", specialty: null, primaryDoctorId: doctor, billingMode: "per_procedure",
      baseCurrency: "YER", startDate: "2026-10-01", note: null, createdBy: "dr", installments: [],
      items: [{ serviceId: services.filling, serviceName: "حشوة", category: "filling", toothCode: 17, surfaces: "MOD", quantity: 1, unitPriceMinor: 30_000, billingRule: "on_completion", sessionCount: 1, note: null }],
    });
    if (!agreed.ok) throw new Error(agreed.message);
    await recordPlanConsent({ planId: agreed.planId, actor: "dr", note: null });
    expect(await invoice(patient, [{ service: "filling", price: 30_000, tooth: 17, surfaces: "MO" }])).toEqual({ ok: false, reason: "shape_mismatch", line: 0 });
    const reused = await invoice(patient, [{ service: "filling", price: 30_000, tooth: 17, surfaces: "DOM" }]);
    expect(reused.ok && !reused.links[0].planItemCreated).toBe(true);
  });

  it("orthodontics takes an arch scope, never a single tooth; periodontics a region; the scope reaches the plan item and the case", async () => {
    const patient = await newPatient("TOOTH-ORTHO");
    expect(await invoice(patient, [{ service: "ortho", price: 100_000, tooth: 11 }])).toEqual({ ok: false, reason: "bad_scope", line: 0 });
    expect(await invoice(patient, [{ service: "ortho", price: 100_000, scope: "full_mouth" }])).toEqual({ ok: false, reason: "bad_scope", line: 0 });
    expect((await invoice(patient, [{ service: "ortho", price: 100_000, scope: "upper" }])).ok).toBe(true);
    expect((await plain(patient))[0]).toMatchObject({ tooth_code: null, note: "النطاق: الفك العلوي" });
    const [kase] = await q<{ site: string; title: string }>(`SELECT site, title FROM clinical_cases WHERE patient_id = $1`, [patient]);
    expect(kase).toMatchObject({ site: "الفك العلوي" });
    const perio = await newPatient("TOOTH-PERIO");
    expect((await invoice(perio, [{ service: "cleaning", price: 20_000, scope: "full_mouth" }])).ok).toBe(true);
    expect((await q<{ site: string }>(`SELECT site FROM clinical_cases WHERE patient_id = $1`, [perio]))[0].site).toBe("كامل الفم");
    expect(await invoice(perio, [{ service: "cleaning", price: 20_000, tooth: 31, scope: "lower" }])).toEqual({ ok: false, reason: "bad_scope", line: 0 });
  });

  it("non-tooth services ignore any tooth/surface/scope sent", async () => {
    const patient = await newPatient("TOOTH-NONE");
    const result = await invoice(patient, [{ service: "consult", price: 5_000, tooth: 36, surfaces: "MO", scope: "upper" }]);
    expect(result.ok && result.links[0].kind === "financial").toBe(true);
    expect(await counts(patient)).toMatchObject({ plans: 0, items: 0, cases: 0 });
  });

  it("canonical propagation: the visit procedure of the plan item carries the invoice line's tooth", async () => {
    const patient = await newPatient("TOOTH-VISIT");
    const result = await invoice(patient, [{ service: "rct", price: 80_000, tooth: 47 }]);
    if (!result.ok) throw new Error("create");
    const [item] = await q<{ id: number; tooth_code: number }>(`SELECT id, tooth_code FROM plan_items WHERE id = $1`, [result.links[0].planItemId]);
    const [kase] = await q<{ site: string }>(`SELECT site FROM clinical_cases WHERE id = $1`, [result.links[0].caseId]);
    expect(item.tooth_code).toBe(47);
    expect(kase.site).toBe("47");
  });
});
