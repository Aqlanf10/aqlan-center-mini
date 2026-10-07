import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (INV-LEGACY) «علاج بدأ قبل النظام» على التطبيق المبني: الصلاحيات قبل قراءة الطلب (الاستقبال والمدير يسجّلان، والإبطال
 * للمدير وحده، والطبيب والصندوق والمحاسبة 403 برسالةٍ عربية)، والتحقق 400 عربي، والإعادة 200 والجديد 201، بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let orthoService = 0;
let rctService = 0;
const stamp = Date.now();
const ARABIC = /[؀-ۿ]/;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  ({ rows: [{ id: patientId }] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name) VALUES ($1, 'علاج قبل النظام') RETURNING id`, [`LT-${stamp}`]));
  const service = async (name: string, category: string) => (await db.query<{ id: number }>(
    `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 300000, TRUE, TRUE, $2) RETURNING id`,
    [`${name} ${stamp}`, category])).rows[0].id;
  orthoService = await service("تقويم ثابت", "ortho");
  rctService = await service("علاج عصب", "rct");
}, 120_000);
afterAll(async () => { await db?.end(); });

type Who = "reception" | "admin" | "doctorA" | "cashier" | "accountant";
const post = (who: Who, body: Record<string, unknown>, patient = patientId) =>
  authedMutation(`/api/patients/${patient}/legacy-treatments`, h.sessions[who], "POST", JSON.stringify({
    currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30", ...body,
  }));
const json = async (response: Response) => await response.json() as Record<string, unknown> & { message?: string };

describe("(INV-LEGACY) POST /api/patients/[id]/legacy-treatments", () => {
  it("reception registers 300,000 / 120,000: 201 with remaining 180,000; the same key replays 200; another body 409", async () => {
    const body = { serviceId: orthoService, idempotencyKey: `legacy:http-${stamp}` };
    const created = await post("reception", body);
    expect(created.status).toBe(201);
    const first = await json(created) as { agreement: { id: number; remainingMinor: number; openingEffect: string }; replayed: boolean };
    expect(first.agreement).toMatchObject({ remainingMinor: 180_000, openingEffect: "created" });
    expect(first.replayed).toBe(false);

    const replay = await post("reception", body);
    expect(replay.status).toBe(200);
    expect(((await json(replay)) as { agreement: { id: number } }).agreement.id).toBe(first.agreement.id);

    const conflict = await post("reception", { ...body, previouslyPaidAmount: "100000" });
    expect(conflict.status).toBe(409);
    expect((await json(conflict)).message).toContain("أُرسل سابقًا");

    const duplicate = await post("reception", { serviceId: orthoService });
    expect(duplicate.status).toBe(409);
    const duplicatePayload = await json(duplicate);
    expect(duplicatePayload.message).toMatch(ARABIC);
    expect(JSON.stringify(duplicatePayload)).not.toMatch(/SELECT|legacy_treatment_agreements|stack|Error:/i);

    const { rows: money } = await db.query<{ payments: number; invoices: number; opening: string }>(
      `SELECT (SELECT COUNT(*)::int FROM payments WHERE patient_id = $1) AS payments,
              (SELECT COUNT(*)::int FROM invoices WHERE patient_id = $1) AS invoices,
              (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER') AS opening`, [patientId]);
    expect(money[0]).toEqual({ payments: 0, invoices: 0, opening: "180000" });
    const { rows: audit } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'legacy_treatment.create' AND entity_id = $1::text`, [patientId]);
    expect(audit).toHaveLength(1);
  });

  it("validation is Arabic 400: paid > agreed, future cutoff, unknown currency, non-clinical service, bad tooth, bad key", async () => {
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
      const response = await post("reception", body);
      expect({ body, status: response.status }).toEqual({ body, status: 400 });
      expect((await json(response)).message).toMatch(ARABIC);
    }
    const { rows: [consult] } = await db.query<{ id: number }>(
      `INSERT INTO services (name, price_minor, is_active, price_configured, category) VALUES ($1, 5000, TRUE, TRUE, 'consultation') RETURNING id`,
      [`كشف ${stamp}`]);
    const financial = await post("reception", { serviceId: consult.id });
    expect(financial.status).toBe(400);
    expect((await json(financial)).message).toContain("خدمةً علاجية");
  });

  it("doctor, cashier and accountant cannot register (403 Arabic, before reading the body); unknown patient 404", async () => {
    for (const who of ["doctorA", "cashier", "accountant"] as const) {
      const response = await authedMutation(`/api/patients/${patientId}/legacy-treatments`, h.sessions[who], "POST", "{}");
      expect({ who, status: response.status }).toEqual({ who, status: 403 });
      expect((await json(response)).message).toMatch(ARABIC);
    }
    const missing = await post("admin", { serviceId: rctService, toothCode: 36 }, 987654321);
    expect(missing.status).toBe(404);
    expect((await json(missing)).message).toMatch(ARABIC);
  });

  it("GET lists the historical agreement for front desk; void is admin-only, with a reason, and audited", async () => {
    const list = await authedGet(`/api/patients/${patientId}/legacy-treatments`, h.sessions.reception);
    expect(list.status).toBe(200);
    const payload = await json(list) as { agreements: { id: number; agreedMinor: number; previouslyPaidMinor: number; remainingMinor: number; status: string }[]; access: { void: boolean } };
    expect(payload.access.void).toBe(false);
    const live = payload.agreements.find((one) => one.status === "live")!;
    expect(live).toMatchObject({ agreedMinor: 300_000, previouslyPaidMinor: 120_000, remainingMinor: 180_000 });

    const byReception = await authedMutation(`/api/patients/${patientId}/legacy-treatments/${live.id}/void`, h.sessions.reception, "POST", JSON.stringify({ reason: "خطأ إدخال" }));
    expect(byReception.status).toBe(403);
    expect((await json(byReception)).message).toMatch(ARABIC);
    const noReason = await authedMutation(`/api/patients/${patientId}/legacy-treatments/${live.id}/void`, h.sessions.admin, "POST", JSON.stringify({ reason: "" }));
    expect(noReason.status).toBe(400);
    expect((await json(noReason)).message).toMatch(ARABIC);
    const voided = await authedMutation(`/api/patients/${patientId}/legacy-treatments/${live.id}/void`, h.sessions.admin, "POST", JSON.stringify({ reason: "خطأ إدخال" }));
    expect(voided.status).toBe(200);
    expect(((await json(voided)) as { agreement: { status: string } }).agreement.status).toBe("void");
    const again = await authedMutation(`/api/patients/${patientId}/legacy-treatments/${live.id}/void`, h.sessions.admin, "POST", JSON.stringify({ reason: "مرة أخرى" }));
    expect(again.status).toBe(409);
    const { rows } = await db.query<{ amount: string | null }>(
      `SELECT (SELECT amount_minor::text FROM patient_opening_balances WHERE patient_id = $1 AND currency = 'YER') AS amount`, [patientId]);
    expect(rows[0].amount).toBeNull();
    const { rows: audit } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'legacy_treatment.void' AND entity_id = $1::text`, [patientId]);
    expect(audit).toHaveLength(1);
  });
});
