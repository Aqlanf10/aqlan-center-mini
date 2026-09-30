import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";

/**
 * (Slice 7) تقارير سير العمل الجديد في مركز التقارير — على PostgreSQL 18:
 * تفصيل العمولات من المحرّك نفسه، الإحالات الداخلية مع تراكمها المفتوح، وجريان الكرسي من سجل التدقيق.
 */

assertRealPostgresUrl();
stubPostgresEnv();

const db = await import("../../lib/db");
const {
  ensureSchema, getPool, resetPoolForTesting, invalidateSettingsCache, openShift, addVisit, seatVisitGated, clearVisit,
  deferVisitPayment, setVisitProcedures, signClinicalVisit, recordPayment, createInternalReferral, transitionInternalReferral,
  commissionDetailReport, CLINIC_TIME_ZONE,
} = db;
const { buildReport, parseFilters } = await import("../../lib/reports");
const { clinicDateString } = await import("../../lib/schedule");

async function q<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

const TODAY = clinicDateString(new Date(), CLINIC_TIME_ZONE);
const todayFilters = (extra: Record<string, string> = {}) =>
  parseFilters(new URLSearchParams({ preset: "custom", from: TODAY, to: TODAY, ...extra }), TODAY);
const reception = { actor: "reception1", actorRole: "reception" };

let orthodontist = 0;
let endodontist = 0;
let fillingId = 0;
let patientSeq = 0;

async function patient(): Promise<number> {
  patientSeq += 1;
  return (await q<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, $2, $3) RETURNING id`,
    [`RO-${patientSeq}`, `مريض التقارير ${patientSeq}`, orthodontist]))[0].id;
}

async function signedFilling(patientId: number): Promise<{ visitId: number; invoiceId: number }> {
  const visit = await addVisit({ patientName: "مريض", patientPhone: null, note: null, patientId, doctorId: endodontist });
  await q(`UPDATE visits SET diagnosis = 'تسوّس' WHERE id = $1`, [visit.id]);
  await setVisitProcedures({
    visitId: visit.id,
    procedures: [{ serviceId: fillingId, toothCode: 16, surfaces: null, quantity: 1, unitPriceMinor: 20000, priceReason: null, doctorId: endodontist, note: null, planItemId: null }],
  });
  const signed = await signClinicalVisit({ visitId: visit.id, baseCurrency: "YER", signedBy: "dr-mohammed", signerDoctorPartyId: endodontist });
  if (signed.reason !== null || !signed.invoiceId) throw new Error(`sign: ${signed.reason}`);
  return { visitId: visit.id, invoiceId: signed.invoiceId };
}

beforeAll(async () => {
  await dropPublicSchema(process.env.DATABASE_URL!);
  await ensureSchema();
  await openShift({ openedBy: "cashier", opening: { YER: 0, SAR: 0, USD: 0 } });
  const doctor = async (name: string) => (await q<{ id: number }>(
    `INSERT INTO parties (kind, name, commission_percent) VALUES ('doctor', $1, 30) RETURNING id`, [name]))[0].id;
  orthodontist = await doctor("د. عقلان");
  endodontist = await doctor("د. محمد");
  fillingId = (await q<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ('حشوة', 20000, TRUE, TRUE, 'filling') RETURNING id`))[0].id;
}, 180_000);
afterAll(async () => { await resetPoolForTesting(); });

describe("(Slice 7) commission-detail in the report center", () => {
  it("is the engine's own detail: same lines, same earned total, filterable by doctor", async () => {
    const p = await patient();
    const { invoiceId } = await signedFilling(p);
    const paid = await recordPayment({
      patientId: p, invoiceId, kind: "payment", amountMinor: 20000, currency: "YER", baseCurrency: "YER",
      exchangeRate: 1, method: "cash", note: null, createdBy: "cashier",
    });
    expect(paid.reason).toBeNull();
    const report = await buildReport("commission-detail", todayFilters({ doctorId: String(endodontist) }));
    const engine = await commissionDetailReport(TODAY, TODAY, { doctorId: endodontist });
    expect(report.rows?.length).toBe(engine.lines.length);
    expect(report.rows?.map((row) => row.earnedMinor)).toEqual(engine.lines.map((line) => line.earnedMinor));
    expect(report.rows?.[0]).toMatchObject({ doctorName: "د. محمد", serviceName: "حشوة", percent: 30, amountMinor: 20000 });
    expect(report.kpis.find((kpi) => kpi.key === "earned")?.minor).toBe(engine.lines.reduce((sum, line) => sum + line.earnedMinor, 0));
    expect((await buildReport("commission-detail", todayFilters({ doctorId: String(orthodontist) }))).rows).toEqual([]);
  });
});

describe("(Slice 7) internal-referrals", () => {
  it("counts the period's referrals by state and keeps an old open referral visible (the backlog)", async () => {
    const p = await patient();
    const make = async (reason: string) => {
      const created = await createInternalReferral({
        patientId: p, doctorPartyId: orthodontist, toPartyId: endodontist, toSpecialty: "endodontics",
        reason, teeth: "21", urgency: "routine", caseId: null, blocksCaseId: null, planItemId: null,
        requestedServiceId: null, actor: "dr-aqlan", actorRole: "doctor",
      });
      if (!created.ok) throw new Error(created.reason);
      return created.referral.id;
    };
    const requested = await make("تقييم عصب 21");
    const accepted = await make("علاج عصب 22");
    await transitionInternalReferral({ id: accepted, action: "accept", note: null, appointmentId: null, procedurePerformed: null, followupRequired: null, mayReturn: null, actor: "dr-mohammed", actorRole: "doctor" });
    const old = await make("إحالة قديمة مفتوحة");
    await q(`UPDATE patient_referrals SET created_at = NOW() - INTERVAL '40 days' WHERE id = $1`, [old]);

    const report = await buildReport("internal-referrals", todayFilters());
    const ids = report.rows?.map((row) => row.state);
    expect(ids).toHaveLength(3);
    expect(report.kpis.find((kpi) => kpi.key === "open")?.count).toBe(3);
    expect(report.kpis.find((kpi) => kpi.key === "requested")?.count).toBe(2);
    expect(report.kpis.find((kpi) => kpi.key === "waiting_booking")?.count).toBe(1);
    const oldRow = report.rows?.find((row) => row.days !== null && Number(row.days) >= 39);
    expect(oldRow).toMatchObject({ from: "د. عقلان", to: "د. محمد", specialty: "علاج الجذور (العصب)" });
    expect(requested).toBeGreaterThan(0);
    /* مرشّح الطبيب: المحيل أو المستقبِل — طبيبٌ لا صلة له يرى صفرًا. */
    const [stranger] = await q<{ id: number }>(`INSERT INTO parties (kind, name) VALUES ('doctor', 'د. آخر') RETURNING id`);
    expect((await buildReport("internal-referrals", todayFilters({ doctorId: String(stranger.id) }))).rows).toEqual([]);
  });
});

describe("(Slice 7) chair-flow", () => {
  it("reports the period's visits, clearances, emergency bypasses (with reason) and deferred payments", async () => {
    await q(`INSERT INTO settings (key, value) VALUES ('ops.require_clearance_before_call', 'true')
             ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
    invalidateSettingsCache();
    const before = await buildReport("chair-flow", todayFilters());
    const p = await patient();
    const cleared = await addVisit({ patientName: "مريض", patientPhone: null, note: null, patientId: p, doctorId: orthodontist });
    await clearVisit(cleared.id, reception);

    const q2 = await patient();
    const emergency = await addVisit({ patientName: "مريض", patientPhone: null, note: null, patientId: q2, doctorId: orthodontist });
    const seated = await seatVisitGated(emergency.id, 9, { actor: "dr.aqlan", actorRole: "doctor" }, { requested: true, reason: "نزيف بعد خلع" });
    expect(seated).toMatchObject({ ok: true, bypassed: true });

    const p3 = await patient();
    const { visitId } = await signedFilling(p3);
    expect(await deferVisitPayment(visitId, reception)).toMatchObject({ ok: true, already: false });

    const report = await buildReport("chair-flow", todayFilters());
    const kpi = (key: string) => report.kpis.find((one) => one.key === key)?.count ?? 0;
    const kpiBefore = (key: string) => before.kpis.find((one) => one.key === key)?.count ?? 0;
    expect(kpi("arrived") - kpiBefore("arrived")).toBe(3);
    expect(kpi("cleared") - kpiBefore("cleared")).toBe(1);
    expect(kpi("bypasses") - kpiBefore("bypasses")).toBe(1);
    expect(kpi("deferred") - kpiBefore("deferred")).toBe(1);
    const bypassRow = report.rows?.find((row) => row.kind === "تجاوز طارئ للبوابة" && row.visit === `#${emergency.id}`);
    expect(bypassRow).toMatchObject({ patientId: q2, actor: "dr.aqlan" });
    expect(String(bypassRow?.detail)).toContain("نزيف بعد خلع");
    expect(report.rows?.find((row) => row.visit === `#${visitId}`)).toMatchObject({ kind: "تأجيل الدفع", patientId: p3 });

    /* مرشّح المريض يسري على العدّ والحوادث معًا. */
    const scoped = await buildReport("chair-flow", todayFilters({ patientId: String(q2) }));
    expect(scoped.kpis.find((one) => one.key === "arrived")?.count).toBe(1);
    expect(scoped.rows?.map((row) => row.kind)).toEqual(["تجاوز طارئ للبوابة"]);
  });
});
