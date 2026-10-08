import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (COMM-DETAIL-1) تفصيل العمولة والنسبة الخاصة بالحالة وتكلفة المواد ومطابقة الخدمة —
 * على PostgreSQL 18 الحقيقي، عبر `commissionReport` / `commissionDetailReport` نفسيهما.
 *
 * المبدأ: محرّكٌ واحد. التفصيل مصبٌّ له: مجموع السطور = صفّ المجاميع حرفيًّا، والتقرير
 * بلا تفصيل يعطي الأرقام نفسها.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  commissionDetailReport, commissionReport, createCaseOverride, createParty, createStaffUser,
  ensureSchema, getPool, invalidateSettingsCache, resetPoolForTesting, updateUser,
} = db;

type Currency = "YER" | "SAR" | "USD";
let seq = 0;
let shiftId = 0;

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

async function doctor(name: string, percent: number): Promise<number> {
  return (await createParty({ name, kind: "doctor", phone: null, commissionPercent: percent, note: null })).id;
}

async function configure(partyId: number, config: Record<string, unknown>): Promise<void> {
  seq += 1;
  const user = await createStaffUser({ username: `cd${seq}`, displayName: `cd${seq}`, passwordHash: "x", role: "doctor", partyId });
  await updateUser(user.id, {
    commissionConfig: {
      calculationMode: "percentage", defaultPercent: 30, categoryRates: {}, fixedAmountPerVisitMinor: 0,
      deductLabCost: false, deductMaterialCost: false, basis: "collected_cash", effectiveDate: "", rateHistory: [],
      ...config,
    },
  }, { actor: "owner" });
}

/** سياسة الإعداد المتقدّم تسري من لحظة حفظها (سجلٌّ زمني) — فأعمال هذه الحالات بعدها. */
const soon = (minutes: number) => new Date(Date.now() + minutes * 60_000).toISOString();

async function patient(): Promise<number> {
  seq += 1;
  const [row] = await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, $2) RETURNING id`, [`CD-${seq}`, `مريض تفصيل ${seq}`]);
  return row.id;
}

async function service(name: string, category: string | null): Promise<number> {
  const [row] = await q<{ id: number }>(`INSERT INTO services (name, category) VALUES ($1, $2) RETURNING id`, [name, category]);
  return row.id;
}

/** زيارة موقّعة وفاتورتها — كل بند بطبيبه وخدمته، واختياريًّا من بند خطة (حالة). */
async function visitInvoice(input: {
  patientId: number; at: string; currency?: Currency;
  items: Array<{ doctorId: number; amount: number; serviceId?: number; description?: string; planItemId?: number }>;
}): Promise<{ invoiceId: number; visitId: number }> {
  seq += 1;
  const total = input.items.reduce((sum, item) => sum + item.amount, 0);
  const [invoice] = await q<{ id: number }>(
    `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at)
     VALUES ($1, $2, $3, 0, $4, 'test', $5::timestamptz) RETURNING id`,
    [`CD-INV-${seq}`, input.patientId, total, input.currency ?? "YER", input.at]);
  const [visit] = await q<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id, doctor_id, status, invoice_id, arrived_at, signed_at, signed_by)
     VALUES ('مريض', $1, $2, 'done', $3, $4::timestamptz, $4::timestamptz, 'test') RETURNING id`,
    [input.patientId, input.items[0].doctorId, invoice.id, input.at]);
  for (const item of input.items) {
    let sourceId: number | null = null;
    if (item.serviceId) {
      const [procedure] = await q<{ id: number }>(
        `INSERT INTO visit_procedures (visit_id, service_id, doctor_id, quantity, unit_price_minor, plan_item_id)
         VALUES ($1, $2, $3, 1, $4, $5) RETURNING id`,
        [visit.id, item.serviceId, item.doctorId, item.amount, item.planItemId ?? null]);
      sourceId = procedure.id;
    }
    await q(
      `INSERT INTO invoice_items (invoice_id, service_id, description, quantity, unit_price_minor, total_minor, doctor_id, source_type, source_id)
       VALUES ($1, $2, $3, 1, $4, $4, $5, $6, $7)`,
      [invoice.id, item.serviceId ?? null, item.description ?? "بند", item.amount, item.doctorId,
        sourceId === null ? null : "visit_procedure", sourceId]);
  }
  return { invoiceId: invoice.id, visitId: visit.id };
}

async function pay(patientId: number, invoiceId: number, amount: number, at: string, currency: Currency = "YER"): Promise<void> {
  seq += 1;
  await q(
    `INSERT INTO payments (receipt_number, patient_id, invoice_id, shift_id, kind, amount_minor, currency,
       exchange_rate, base_amount_minor, base_currency, method, created_by, created_at)
     VALUES ($1, $2, $3, $4, 'payment', $5, $6, 1, $5, $6, 'cash', 'test', $7::timestamptz)`,
    [`CD-R-${seq}`, patientId, invoiceId, shiftId, amount, currency, at]);
}

async function inventoryItem(name: string): Promise<number> {
  const [row] = await q<{ id: number }>(`INSERT INTO inventory_items (name, created_by) VALUES ($1, 'test') RETURNING id`, [name]);
  return row.id;
}

async function movement(input: {
  itemId: number; kind: "in" | "out"; qty: number; unitCost?: number | null; visitId?: number; patientId?: number; isReturn?: boolean;
}): Promise<void> {
  await q(
    `INSERT INTO inventory_movements (item_id, kind, qty, visit_id, patient_id, created_by, unit_cost_minor, is_return)
     VALUES ($1, $2, $3, $4, $5, 'test', $6, $7)`,
    [input.itemId, input.kind, input.qty, input.visitId ?? null, input.patientId ?? null, input.unitCost ?? null, input.isReturn ?? false]);
}

/** مجموع سطور التفصيل = صفّ المجاميع لكل (طبيب × عملة) — حرفيًّا. */
async function expectLinesSumToTotals(from = "1970-01-01", to = "2999-12-31") {
  const detail = await commissionDetailReport(from, to);
  const plain = await commissionReport(from, to);
  expect(detail.rows).toEqual(plain);
  for (const row of plain) {
    const mine = detail.lines.filter((line) => line.doctorId === row.doctorId && line.currency === row.currency);
    expect(mine.reduce((sum, line) => sum + line.accruedMinor, 0), `accrued ${row.doctorName} ${row.currency}`).toBe(row.accruedMinor);
    expect(mine.reduce((sum, line) => sum + line.earnedMinor, 0), `earned ${row.doctorName} ${row.currency}`).toBe(row.earnedMinor);
  }
  return detail;
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
});

beforeEach(async () => {
  await q(`TRUNCATE commission_case_overrides, doctor_commission_history, payments, expenses, invoice_items, lab_orders,
                    visit_procedures, inventory_movements, service_materials, inventory_items, plan_items, clinical_cases,
                    treatment_plans, visits, invoices, patients, cashier_shifts, users, parties, services
           RESTART IDENTITY CASCADE`);
  const [shift] = await q<{ id: number }>(`INSERT INTO cashier_shifts (opened_by) VALUES ('cd') RETURNING id`);
  shiftId = shift.id;
});

afterAll(async () => {
  await resetPoolForTesting();
});

describe("F-8 — التفصيل من المحرّك نفسه", () => {
  it.each([
    ["collected_cash", 0], ["collected_cash", 12.345], ["invoiced", 0], ["invoiced", 12.345],
  ] as const)("explicit general %s/%s preserves all prior facts and uses the existing event-time cutover", async (basis, percent) => {
    const d = await doctor("د. قصد مالي", 20);
    seq += 1;
    const user = await createStaffUser({ username: `intent${seq}`, displayName: "قصد مالي", passwordHash: "x", role: "doctor", partyId: d });
    const p = await patient(); const serviceId = await service("عمل قصد مالي", "rct");
    const beforeAt = new Date(Date.now() - 3_600_000).toISOString();
    const old = await visitInvoice({ patientId: p, at: beforeAt, items: [{ doctorId: d, serviceId, amount: 10000 }] });
    await pay(p, old.invoiceId, 5000, beforeAt);
    const facts = async () => ({
      invoices: await q(`SELECT * FROM invoices WHERE id = $1`, [old.invoiceId]),
      items: await q(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY id`, [old.invoiceId]),
      visits: await q(`SELECT * FROM visits WHERE id = $1`, [old.visitId]),
      procedures: await q(`SELECT * FROM visit_procedures WHERE visit_id = $1 ORDER BY id`, [old.visitId]),
      initialPayment: await q(`SELECT * FROM payments WHERE invoice_id = $1 ORDER BY id LIMIT 1`, [old.invoiceId]),
    });
    const beforeFacts = await facts();
    const history = async () => q(`SELECT * FROM doctor_commission_history WHERE party_id = $1 ORDER BY id`, [d]);
    const audits = async () => q(`SELECT * FROM audit_log WHERE action = 'doctor.commission.update' AND entity = 'party' AND entity_id = $1 ORDER BY id`, [String(d)]);
    const initialHistory = await history(); const initialAudits = await audits();
    const before = (await commissionDetailReport("1970-01-01", "2999-12-31")).lines.filter(line => line.invoiceId === old.invoiceId);
    expect(before).toHaveLength(1); expect(before[0]).toMatchObject({ percent: 20, earnedMinor: 1000 });
    expect((await q(`SELECT commission_config FROM users WHERE id = $1`, [user.id]))[0].commission_config).toBeNull();
    await updateUser(user.id, { displayName: "تحديث أساسي فقط" }, { actor: "intent-owner", actorRole: "admin" });
    expect((await q(`SELECT commission_config FROM users WHERE id = $1`, [user.id]))[0].commission_config).toBeNull();
    expect(await history()).toEqual(initialHistory); expect(await audits()).toEqual(initialAudits); expect(await facts()).toEqual(beforeFacts);
    expect((await commissionDetailReport("1970-01-01", "2999-12-31")).lines.filter(line => line.invoiceId === old.invoiceId)).toEqual(before);
    const { parseDoctorCommissionConfig, validateDoctorCommissionConfigInput } = await import("../../lib/doctor-permissions");
    const checked = validateDoctorCommissionConfigInput({ ...parseDoctorCommissionConfig(null), basis, defaultPercent: percent, deductLabCost: false, deductMaterialCost: false });
    if (!checked.ok) throw new Error(checked.message);
    await updateUser(user.id, { commissionConfig: checked.value }, { actor: "intent-owner", actorRole: "admin", reason: "تعديل مالي صريح" });
    const savedHistory = await history();
    // createParty/createStaffUser already establish canonical history; preserve it.
    expect(initialHistory.length).toBeGreaterThan(0);
    expect(initialHistory[0]).toMatchObject({ config: null, source: "baseline" }); expect(Number(initialHistory[0].percent)).toBe(20);
    expect(savedHistory).toHaveLength(initialHistory.length + 1);
    expect(savedHistory.slice(0, initialHistory.length)).toEqual(initialHistory);
    expect(savedHistory.at(-1)).toMatchObject({ config: { defaultPercent: percent, basis }, source: "advanced" });
    expect(Number(savedHistory.at(-1)!.percent)).toBe(20);
    const [cutover] = await q<{ at: string }>(`SELECT to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM doctor_commission_history WHERE party_id = $1 ORDER BY effective_from DESC, id DESC LIMIT 1`, [d]);
    expect(new Date(beforeAt).getTime()).toBeLessThan(new Date(cutover.at).getTime());
    expect(await facts()).toEqual(beforeFacts);
    expect((await commissionDetailReport("1970-01-01", "2999-12-31")).lines.filter(line => line.invoiceId === old.invoiceId)).toEqual(before);
    const savedAudits = await audits(); expect(savedAudits).toHaveLength(initialAudits.length + 1);
    expect(savedAudits.slice(0, initialAudits.length)).toEqual(initialAudits);
    expect(savedAudits.at(-1)).toMatchObject({ actor: "intent-owner", details: { "قبل_القيمة": { percent: 20, config: null }, "بعد_القيمة": { percent: 20, config: { defaultPercent: percent, basis } } } });
    expect(Number((await q(`SELECT commission_percent FROM parties WHERE id = $1`, [d]))[0].commission_percent)).toBe(20);
    await pay(p, old.invoiceId, 5000, cutover.at);
    const fresh = await visitInvoice({ patientId: p, at: cutover.at, items: [{ doctorId: d, serviceId, amount: 10000 }] });
    await pay(p, fresh.invoiceId, 10000, cutover.at);
    const detail = await expectLinesSumToTotals();
    expect(detail.lines.find(line => line.invoiceId === fresh.invoiceId)).toMatchObject({ percent, earnedMinor: Math.round(10000 * percent / 100) });
    const oldLine = detail.lines.find(line => line.invoiceId === old.invoiceId)!;
    // The invoice predates the edit, so its ordinary collected-cash basis stays.
    // Its later collection uses the new event-time percentage under either new basis.
    // Preserve the engine's two-stage rounding: full share, then covered fraction.
    const laterEarned = Math.round(Math.round(10000 * percent / 100) * 0.5);
    expect(oldLine).toMatchObject({ percent: 20, basis: "collected_cash", accruedMinor: 2000, earnedMinor: 1000 + laterEarned });
    expect(oldLine.earnedParts.find(part => part.percent === 20)).toEqual(before[0].earnedParts[0]);
    if (percent === 0) expect(oldLine.earnedParts).toEqual(before[0].earnedParts);
    else expect(oldLine.earnedParts.find(part => part.percent === percent)).toMatchObject({ coveredMinor: 5000, earnedMinor: laterEarned });
    expect(await facts()).toEqual(beforeFacts); expect(await history()).toEqual(savedHistory); expect(await audits()).toEqual(savedAudits);
  });

  it.each(["collected_cash", "invoiced"] as const)("canonical category edits preserve old raw-key policies and facts under %s", async (basis) => {
    const d = await doctor("د. فئات", 20);
    const rct = await service("عصب عادي", "rct");
    const legacy = await service("خدمة قديمة", "endo");
    const special = await service("عصب خاص", "rct");
    const filling = await service("حشوة", "filling");
    const config = {
      calculationMode: "by_category" as const, defaultPercent: 17,
      categoryRates: { endo: 72, unknown_saved: 41 },
      customServiceRates: [{ id: "specific", serviceId: special, serviceName: "عصب خاص", percent: 83 }],
      deductLabCost: false, deductMaterialCost: false, basis,
    };
    await configure(d, config);
    const [user] = await q<{ id: number; commission_config: string }>(`SELECT id, commission_config FROM users WHERE party_id = $1`, [d]);
    const { parseDoctorCommissionConfig, validateDoctorCommissionConfigInput } = await import("../../lib/doctor-permissions");
    const initial = parseDoctorCommissionConfig(user.commission_config);
    expect(initial.categoryRates).not.toHaveProperty("rct");
    const [first] = await q<{ at: string }>(`SELECT to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at
      FROM doctor_commission_history WHERE party_id = $1 ORDER BY effective_from DESC, id DESC LIMIT 1`, [d]);
    const p = await patient();
    const items = [rct, legacy, special, filling].map((serviceId) => ({ doctorId: d, serviceId, amount: 10000 }));
    const old = await visitInvoice({ patientId: p, at: first.at, items });
    await pay(p, old.invoiceId, 20000, first.at);
    const before = (await commissionDetailReport("1970-01-01", "2999-12-31")).lines.filter((line) => line.invoiceId === old.invoiceId);
    expect(before.find((line) => line.serviceName === "عصب عادي")).toMatchObject({ percent: 17, ruleSource: "default", earnedMinor: basis === "invoiced" ? 1700 : 850 });
    expect(before.find((line) => line.serviceName === "خدمة قديمة")).toMatchObject({ percent: 72, ruleSource: "category", earnedMinor: basis === "invoiced" ? 7200 : 3600 });
    expect(before.find((line) => line.serviceName === "عصب خاص")).toMatchObject({ percent: 83, ruleSource: "custom_service", earnedMinor: basis === "invoiced" ? 8300 : 4150 });
    const facts = async () => q(`SELECT jsonb_build_object(
      'invoice', (SELECT to_jsonb(i) FROM invoices i WHERE id = $1),
      'initial_payment', (SELECT to_jsonb(p) FROM payments p WHERE invoice_id = $1 ORDER BY id LIMIT 1),
      'initial_history', (SELECT jsonb_agg(to_jsonb(h) ORDER BY id) FROM doctor_commission_history h WHERE party_id = $2 AND effective_from <= $3::timestamptz)
    ) AS snapshot`, [old.invoiceId, d, first.at]);
    const beforeFacts = await facts();
    const checked = validateDoctorCommissionConfigInput({ ...initial, categoryRates: { ...initial.categoryRates, rct: 55, filling: 49 } });
    if (!checked.ok) throw new Error(checked.message);
    await updateUser(user.id, { commissionConfig: checked.value }, { actor: "category-owner", actorRole: "admin", reason: "نسب فئات الدليل" });
    const [cutover] = await q<{ at: string; config: typeof initial }>(`SELECT to_char(effective_from AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at, config
      FROM doctor_commission_history WHERE party_id = $1 ORDER BY effective_from DESC, id DESC LIMIT 1`, [d]);
    expect(cutover.config.categoryRates).toMatchObject({ endo: 72, unknown_saved: 41, rct: 55, filling: 49 });
    expect(cutover.config.customServiceRates).toEqual(initial.customServiceRates);
    expect(await facts()).toEqual(beforeFacts);
    const unchanged = (await commissionDetailReport("1970-01-01", "2999-12-31")).lines.filter((line) => line.invoiceId === old.invoiceId);
    expect(unchanged).toEqual(before);
    await pay(p, old.invoiceId, 20000, cutover.at);
    const fresh = await visitInvoice({ patientId: p, at: cutover.at, items });
    await pay(p, fresh.invoiceId, 40000, cutover.at);
    const detail = await expectLinesSumToTotals();
    const earned = (invoiceId: number, name: string) => detail.lines.filter((line) => line.invoiceId === invoiceId && line.serviceName === name).reduce((sum, line) => sum + line.earnedMinor, 0);
    expect(earned(old.invoiceId, "عصب عادي")).toBe(basis === "collected_cash" ? 3600 : 1700);
    expect(earned(old.invoiceId, "حشوة")).toBe(basis === "collected_cash" ? 3300 : 1700);
    expect(earned(fresh.invoiceId, "عصب عادي")).toBe(5500);
    expect(earned(fresh.invoiceId, "حشوة")).toBe(4900);
    for (const invoiceId of [old.invoiceId, fresh.invoiceId]) {
      expect(earned(invoiceId, "خدمة قديمة")).toBe(7200);
      expect(earned(invoiceId, "عصب خاص")).toBe(8300);
    }
    expect(await facts()).toEqual(beforeFacts);
    const [audit] = await q<{ actor: string; details: Record<string, unknown> }>(`SELECT actor, details FROM audit_log WHERE action = 'doctor.commission.update' AND entity_id = $1 AND actor = 'category-owner'`, [String(d)]);
    expect(audit.actor).toBe("category-owner");
    expect(audit.details["قبل_القيمة"]).toMatchObject({ config: { defaultPercent: 17, categoryRates: { endo: 72 } } });
    expect(audit.details["بعد_القيمة"]).toMatchObject({ config: { categoryRates: { rct: 55, filling: 49, endo: 72 } } });
  });

  it("سطرٌ لكل حصة بالمريض والفاتورة والزيارة والخدمة والتخصص ومصدر النسبة — ومجموعها = المجاميع", async () => {
    const a = await doctor("د. أ", 30);
    const b = await doctor("د. ب", 40);
    const filling = await service("حشوة", "filling");
    const crown = await service("تاج", "crown");
    const p1 = await patient();
    const p2 = await patient();
    const one = await visitInvoice({ patientId: p1, at: "2024-03-10 09:00+03", items: [
      { doctorId: a, amount: 33333, serviceId: filling }, { doctorId: b, amount: 20001, serviceId: crown },
    ] });
    await q(`INSERT INTO lab_orders (patient_id, lab_name, work_type, sent_date, due_date, status, visit_id, doctor_id, cost_minor, cost_currency)
             VALUES ($1, 'مختبر', 'تاج', DATE '2024-03-01', DATE '2024-03-20', 'delivered', $2, $3, 7001, 'YER')`, [p1, one.visitId, b]);
    await pay(p1, one.invoiceId, 17777, "2024-03-11 10:00+03");
    await pay(p1, one.invoiceId, 9999, "2024-04-02 10:00+03");
    const two = await visitInvoice({ patientId: p2, at: "2024-03-12 09:00+03", currency: "USD", items: [{ doctorId: a, amount: 50000, serviceId: crown }] });
    await pay(p2, two.invoiceId, 12345, "2024-03-13 10:00+03", "USD");

    const detail = await expectLinesSumToTotals();
    expect(detail.lines).toHaveLength(3);
    const line = detail.lines.find((entry) => entry.doctorId === b)!;
    expect(line).toMatchObject({
      patientId: p1, invoiceId: one.invoiceId, visitId: one.visitId, serviceName: "تاج", category: "crown",
      categoryLabel: "تيجان", currency: "YER", amountMinor: 20001, labCostMinor: 7001, labDeducted: true,
      baseMinor: 13000, percent: 40, ruleSource: "default", ruleSourceLabel: "النسبة الافتراضية للطبيب",
    });
    const [named] = await q<{ full_name: string }>(`SELECT full_name FROM patients WHERE id = $1`, [p1]);
    expect(line.patientName).toBe(named.full_name);
    expect(detail.lines.find((entry) => entry.currency === "USD")?.doctorId).toBe(a);

    // المرشّحات: الطبيب والعملة والتخصص.
    expect((await commissionDetailReport("1970-01-01", "2999-12-31", { doctorId: a })).lines.every((entry) => entry.doctorId === a)).toBe(true);
    expect((await commissionDetailReport("1970-01-01", "2999-12-31", { currency: "USD" })).lines).toHaveLength(1);
    expect((await commissionDetailReport("1970-01-01", "2999-12-31", { category: "filling" })).lines.map((entry) => entry.serviceName)).toEqual(["حشوة"]);
  });
});

describe("F-11 — النسبة الخاصة بالحالة (إلحاقيّة، وقت الحدث)", () => {
  async function caseScenario() {
    const a = await doctor("د. يوسف", 30);
    const implant = await service("زراعة", "implant");
    const p = await patient();
    const [kase] = await q<{ id: number }>(
      `INSERT INTO clinical_cases (patient_id, specialty, title, created_by) VALUES ($1, 'implants', 'زراعة ٤٦', 'test') RETURNING id`, [p]);
    const [plan] = await q<{ id: number }>(
      `INSERT INTO treatment_plans (patient_id, title, total_minor) VALUES ($1, 'خطة شاملة', 15000) RETURNING id`, [p]);
    const [item] = await q<{ id: number }>(
      `INSERT INTO plan_items (plan_id, service_id, service_name, quantity, unit_price_minor, case_id)
       VALUES ($1, $2, 'زراعة', 1, 15000, $3) RETURNING id`, [plan.id, implant, kase.id]);
    const { invoiceId } = await visitInvoice({ patientId: p, at: "2024-03-10 09:00+03", items: [
      { doctorId: a, amount: 15000, serviceId: implant, planItemId: item.id },
    ] });
    return { a, p, caseId: kase.id, planId: plan.id, invoiceId };
  }

  it("تعيين ثم إلغاء: كل دفعة بنسبة لحظتها، والإلغاء يسقط إلى الافتراضي", async () => {
    const { a, p, caseId, invoiceId } = await caseScenario();
    await pay(p, invoiceId, 5000, "2024-03-10 10:00+03");
    await pay(p, invoiceId, 5000, "2024-04-10 10:00+03");
    await pay(p, invoiceId, 5000, "2024-05-10 10:00+03");

    const set = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 50, reason: "اتفاق خاص للحالة",
      effectiveDate: "2024-04-01", supersedesId: null, actor: "owner", actorRole: "admin",
    });
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    const voided = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "void", percent: null, reason: "انتهى الاتفاق",
      effectiveDate: "2024-05-01", supersedesId: set.override.id, actor: "owner", actorRole: "admin",
    });
    expect(voided.ok).toBe(true);

    const detail = await expectLinesSumToTotals();
    const [line] = detail.lines;
    expect(line.caseId).toBe(caseId);
    expect(line.caseTitle).toBe("زراعة ٤٦");
    // وقت الفاتورة قبل النسبة الخاصة ⇒ ٣٠٪؛ دفعة أبريل ٥٠٪؛ دفعتا مارس ومايو ٣٠٪.
    expect(line.accruedMinor).toBe(4500);
    expect(line.earnedMinor).toBe(3000 + 2500);
    expect(line.earnedParts.find((part) => part.percent === 50)?.ruleSources).toEqual(["case_override"]);

    const audit = await q<{ action: string }>(`SELECT action FROM audit_log WHERE entity = 'commission_case_override' ORDER BY id`);
    expect(audit.map((row) => row.action)).toEqual(["commission.case_override.set", "commission.case_override.void"]);
  });

  it("استبدالٌ يخلف السابق؛ ورأسٌ قديم ⇒ 409؛ وسريانٌ يسبق السابق ⇒ 400", async () => {
    const { a, p, caseId, invoiceId } = await caseScenario();
    await pay(p, invoiceId, 15000, "2024-06-10 10:00+03");
    const first = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 25, reason: "نسبة أولى", effectiveDate: "2024-01-01",
      supersedesId: null, actor: "owner",
    });
    if (!first.ok) throw new Error(first.message);
    const stale = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 60, reason: "بلا رأس", effectiveDate: "2024-06-01",
      supersedesId: null, actor: "owner",
    });
    expect(stale).toMatchObject({ ok: false, status: 409 });
    const early = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 60, reason: "قبل السابقة", effectiveDate: "2023-12-01",
      supersedesId: first.override.id, actor: "owner",
    });
    expect(early).toMatchObject({ ok: false, status: 400 });
    const second = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 40, reason: "تعديل الاتفاق", effectiveDate: "2024-06-01",
      supersedesId: first.override.id, actor: "owner",
    });
    expect(second.ok).toBe(true);

    const [line] = (await expectLinesSumToTotals()).lines;
    expect(line.percent).toBe(25); // وقت الفاتورة (مارس) تحت النسبة الأولى
    expect(line.ruleSource).toBe("case_override");
    expect(line.accruedMinor).toBe(3750);
    expect(line.earnedMinor).toBe(6000); // دفعة يونيو تحت ٤٠٪
  });

  it("نسبة خاصة على الخطة تنطبق على بنودها — والحالة أولى منها", async () => {
    const { a, p, planId, caseId, invoiceId } = await caseScenario();
    await pay(p, invoiceId, 15000, "2024-03-11 10:00+03");
    const onPlan = await createCaseOverride({
      doctorId: a, caseId: null, planId, action: "set", percent: 20, reason: "خطة", effectiveDate: "2024-01-01", supersedesId: null, actor: "owner",
    });
    expect(onPlan.ok).toBe(true);
    expect((await expectLinesSumToTotals()).lines[0].earnedMinor).toBe(3000);
    await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 10, reason: "حالة", effectiveDate: "2024-01-01", supersedesId: null, actor: "owner",
    });
    expect((await expectLinesSumToTotals()).lines[0].earnedMinor).toBe(1500);
  });

  it("فاتورة القسط (بلا إجراء زيارة) تحمل خطتها من الفاتورة — فتسري نسبة الخطة الخاصة عليها", async () => {
    const { a, p, planId, invoiceId } = await caseScenario();
    await pay(p, invoiceId, 15000, "2024-03-11 10:00+03"); // الأقدم أولًا (FIFO) — فيُسدَّد القسط بعده بدفعته
    seq += 1;
    const [installment] = await q<{ id: number }>(
      `INSERT INTO invoices (invoice_number, patient_id, total_minor, discount_minor, base_currency, created_by, created_at, plan_id)
       VALUES ($1, $2, 5000, 0, 'YER', 'test', '2024-04-01 09:00+03'::timestamptz, $3) RETURNING id`,
      [`CD-INST-${seq}`, p, planId]);
    await q(
      `INSERT INTO invoice_items (invoice_id, description, quantity, unit_price_minor, total_minor, doctor_id)
       VALUES ($1, 'قسط الخطة', 1, 5000, 5000, $2)`, [installment.id, a]);
    await pay(p, installment.id, 5000, "2024-04-01 10:00+03");
    const created = await createCaseOverride({
      doctorId: a, caseId: null, planId, action: "set", percent: 20, reason: "خطة", effectiveDate: "2024-01-01", supersedesId: null, actor: "owner",
    });
    expect(created.ok).toBe(true);
    const line = (await expectLinesSumToTotals()).lines.find((entry) => entry.invoiceId === installment.id)!;
    expect(line).toMatchObject({ planId, caseId: null, percent: 20, ruleSource: "case_override", earnedMinor: 1000 });
  });

  it("السجل إلحاقيّ: UPDATE وDELETE يُرفضان من القاعدة", async () => {
    const { a, caseId } = await caseScenario();
    const created = await createCaseOverride({
      doctorId: a, caseId, planId: null, action: "set", percent: 25, reason: "سبب", effectiveDate: null, supersedesId: null, actor: "owner",
    });
    if (!created.ok) throw new Error(created.message);
    await expect(q(`UPDATE commission_case_overrides SET percent = 90 WHERE id = $1`, [created.override.id]))
      .rejects.toThrow(/لا تُعدَّل ولا تُحذف/);
    await expect(q(`DELETE FROM commission_case_overrides WHERE id = $1`, [created.override.id]))
      .rejects.toThrow(/لا تُعدَّل ولا تُحذف/);
    await expect(q(`INSERT INTO commission_case_overrides (doctor_id, case_id, percent, reason, effective_from, created_by)
                    VALUES ($1, $2, 10, '  ', NOW(), 'x')`, [a, caseId])).rejects.toThrow();
  });
});

describe("F-4 — تكلفة المواد الفعلية بالمتوسّط المرجّح", () => {
  it("تُخصم لمن تنصّ سياسته، بالمتوسّط لا بثمن الصرف المكتوب، وغير المنسوب يُقال", async () => {
    const a = await doctor("د. مواد", 30);
    await configure(a, { deductMaterialCost: true });
    const b = await doctor("د. بلا خصم", 30);
    await configure(b, { deductMaterialCost: false });
    const implant = await service("زراعة", "implant");
    const fixture = await inventoryItem("غرسة");
    const gloves = await inventoryItem("قفاز");
    await q(`INSERT INTO service_materials (service_id, item_id, qty_per_unit, created_by) VALUES ($1, $2, 2, 'test')`, [implant, fixture]);
    await movement({ itemId: fixture, kind: "in", qty: 10, unitCost: 100 });
    await movement({ itemId: fixture, kind: "in", qty: 10, unitCost: 200 });
    await movement({ itemId: gloves, kind: "in", qty: 100, unitCost: 10 });

    const p = await patient();
    const one = await visitInvoice({ patientId: p, at: soon(1), items: [{ doctorId: a, amount: 10000, serviceId: implant }] });
    // ثمنٌ مكتوب على الصرف (999999) يجب ألا يُقرأ: التكلفة من المتوسّط (150 × 2).
    await movement({ itemId: fixture, kind: "out", qty: 2, unitCost: 999999, visitId: one.visitId, patientId: p });
    await movement({ itemId: gloves, kind: "out", qty: 4, visitId: one.visitId, patientId: p });
    await pay(p, one.invoiceId, 10000, soon(2));

    const two = await visitInvoice({ patientId: p, at: soon(3), items: [{ doctorId: b, amount: 10000, serviceId: implant }] });
    await movement({ itemId: fixture, kind: "out", qty: 2, visitId: two.visitId, patientId: p });
    await pay(p, two.invoiceId, 10000, soon(4));

    const detail = await expectLinesSumToTotals();
    const lineA = detail.lines.find((line) => line.doctorId === a)!;
    expect(lineA).toMatchObject({ materialCostMinor: 300, materialDeducted: true, baseMinor: 9700, earnedMinor: 2910 });
    const lineB = detail.lines.find((line) => line.doctorId === b)!;
    expect(lineB).toMatchObject({ materialCostMinor: 300, materialDeducted: false, earnedMinor: 3000 });
    expect(detail.unallocatedMaterials).toEqual([
      expect.objectContaining({ itemName: "قفاز", invoiceId: one.invoiceId, costMinor: 40, reason: "no_mapping" }),
    ]);
  });
});

describe("F-5 — مطابقة الخدمة بالمعرّف أو بالاسم التامّ", () => {
  it("نسبة «زراعة» ٤٥٪ لا تمسّ «إزالة زراعة»، والقاعدة الملتبسة تُبلَّغ", async () => {
    const a = await doctor("د. زراعة", 30);
    const implant = await service("زراعة", "implant");
    const removal = await service("إزالة زراعة", "surgery");
    await service("تنظيف", "cleaning");
    await service("تنظيف", "cleaning");
    await configure(a, {
      customServiceRates: [
        { id: "r1", serviceName: "زراعة", percent: 45 },
        { id: "r2", serviceName: "تنظيف", percent: 20 },
      ],
    });
    const p = await patient();
    const { invoiceId } = await visitInvoice({ patientId: p, at: soon(1), items: [
      { doctorId: a, amount: 10000, serviceId: implant }, { doctorId: a, amount: 10000, serviceId: removal },
    ] });
    await pay(p, invoiceId, 20000, soon(2));

    const detail = await expectLinesSumToTotals();
    const byService = new Map(detail.lines.map((line) => [line.serviceName, line]));
    expect(byService.get("زراعة")).toMatchObject({ percent: 45, ruleSource: "custom_service", earnedMinor: 4500 });
    expect(byService.get("إزالة زراعة")).toMatchObject({ percent: 30, ruleSource: "default", earnedMinor: 3000 });
    expect(detail.rows[0].earnedMinor).toBe(7500);
    expect(detail.serviceRateFindings).toEqual([
      expect.objectContaining({ doctorId: a, ruleName: "تنظيف", status: "ambiguous", candidateServiceIds: [3, 4] }),
    ]);
  });
});

describe("الأداء — استعلامات دفعية لا استعلام لكل سطر", () => {
  it("عدد الاستعلامات لا يكبر بعدد المرضى والسطور", async () => {
    const a = await doctor("د. دفعي", 30);
    const filling = await service("حشوة", "filling");
    const fixture = await inventoryItem("مادة");
    await q(`INSERT INTO service_materials (service_id, item_id, qty_per_unit, created_by) VALUES ($1, $2, 1, 'test')`, [filling, fixture]);
    await movement({ itemId: fixture, kind: "in", qty: 1000, unitCost: 10 });
    const addPatients = async (count: number) => {
      for (let i = 0; i < count; i += 1) {
        const p = await patient();
        const { invoiceId, visitId } = await visitInvoice({ patientId: p, at: "2024-03-10 09:00+03", items: [{ doctorId: a, amount: 1000, serviceId: filling }] });
        await movement({ itemId: fixture, kind: "out", qty: 1, visitId, patientId: p });
        await pay(p, invoiceId, 1000, "2024-03-10 10:00+03");
      }
    };
    const countQueries = async () => {
      // The report reads settings through a 5-second process cache. Whether that read is counted would depend on
      // the time between the two measurements (seen on CI: 23 vs 22, the only difference being the settings read),
      // not on the number of rows. Start each measurement from the same cache state.
      invalidateSettingsCache();
      const pool = getPool();
      const spy = vi.spyOn(pool, "query");
      try {
        const detail = await commissionDetailReport("2024-03-01", "2024-03-31");
        return { queries: spy.mock.calls.length, lines: detail.lines.length };
      } finally {
        spy.mockRestore();
      }
    };
    await addPatients(3);
    const small = await countQueries();
    await addPatients(12);
    const large = await countQueries();
    expect(small.lines).toBe(3);
    expect(large.lines).toBe(15);
    expect(large.queries).toBe(small.queries);
  });
});
