import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (CASE-1) الحالة التقويمية السابقة وشدّة التقويم على التطبيق المبني: من يكتب اللقطة، ومن لا يصل،
 * وأن الشدّة المكررة لا تُنشئ صفًّا ثانيًا، وأن تقرير المكررات للمدير وحده — وكل رفضٍ برسالة عربية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
let doctorPartyId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const post = (who: Who, path: string, body: unknown) => authedMutation(path, h.sessions[who], "POST", JSON.stringify(body));
const messageOf = async (response: Response) => (await response.json() as { message?: string }).message ?? "";
const baseline = () => ({
  patientId, phase: "working", financialMode: "opening_balance", monthsElapsed: 9, monthsRemaining: 9,
  upperWire: "019×025 SS", lowerWire: "019×025 SS", elastics: "صنف ثانٍ", remainingObjectives: "إنهاء الإطباق",
});

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  doctorPartyId = doctor.party_id;
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id) VALUES ($1, 'مريض تقويم سابق', $2) RETURNING id`,
    [`OB-${stamp}`, doctorPartyId]);
  patientId = patient.id;
}, 120_000);

afterAll(async () => { await db?.end(); });

describe("CASE-1 — legacy baseline permissions", () => {
  it("reception cannot record a baseline (Arabic 403) and nothing is written", async () => {
    const response = await post("reception", "/api/ortho/baseline", baseline());
    expect(response.status).toBe(403);
    expect(await messageOf(response)).toContain("للطبيب والمدير");
    const { rows } = await db.query(`SELECT 1 FROM ortho_cases WHERE patient_id = $1`, [patientId]);
    expect(rows).toEqual([]);
  });

  it("cashier and accountant are blocked at the door", async () => {
    for (const who of ["cashier", "accountant"] as const) {
      const response = await post(who, "/api/ortho/baseline", baseline());
      expect(response.status).toBe(403);
      expect(await messageOf(response)).toMatch(/[؀-ۿ]/);
    }
  });

  it("a doctor who does not own the patient is refused", async () => {
    const response = await post("doctorB", "/api/ortho/baseline", baseline());
    expect(response.status).toBe(403);
  });

  it("validation errors are Arabic 400s without internals", async () => {
    const response = await post("doctorA", "/api/ortho/baseline", { ...baseline(), financialMode: "free" });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "اختر كيف عومل المال قبل النظام." });
  });

  it("the patient's doctor records it (responsible = the doctor), audited, no invoice; a second one is 409", async () => {
    const invoicesBefore = (await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM invoices WHERE patient_id = $1`, [patientId])).rows[0].n;
    const created = await post("doctorA", "/api/ortho/baseline", baseline());
    expect(created.status).toBe(201);
    const { id } = await created.json() as { id: number };
    const { rows: [row] } = await db.query(`SELECT baseline_kind, responsible_doctor_id, legacy_financial_mode FROM ortho_cases WHERE id = $1`, [id]);
    expect(row).toEqual({ baseline_kind: "legacy", responsible_doctor_id: doctorPartyId, legacy_financial_mode: "opening_balance" });
    expect((await db.query<{ n: number }>(`SELECT COUNT(*)::int AS n FROM invoices WHERE patient_id = $1`, [patientId])).rows[0].n).toBe(invoicesBefore);
    const { rows: audit } = await db.query(`SELECT action FROM audit_log WHERE action = 'ortho.baseline' AND entity_id = $1`, [String(patientId)]);
    expect(audit).toHaveLength(1);

    const again = await post("doctorA", "/api/ortho/baseline", baseline());
    expect(again.status).toBe(409);
    expect(await messageOf(again)).toContain("مفتوحة");

    // الاستقبال يقرأ الحالة (للمتابعة) ولا يكتب اللقطة.
    const read = await authedGet(`/api/ortho?patientId=${patientId}`, h.sessions.reception);
    expect(read.status).toBe(200);
  });

  it("a repeated adjustment for the same visit returns the same row (200), not a second one", async () => {
    const { rows: [open] } = await db.query<{ id: number }>(`SELECT id FROM ortho_cases WHERE patient_id = $1`, [patientId]);
    const { rows: [visit] } = await db.query<{ id: number }>(
      `INSERT INTO visits (patient_name, patient_id) VALUES ('مريض تقويم سابق', $1) RETURNING id`, [patientId]);
    const body = { visitId: visit.id, done: "شدّ", nextWeeks: 4 };
    const first = await post("doctorA", `/api/ortho/${open.id}`, body);
    expect(first.status).toBe(201);
    const second = await post("doctorA", `/api/ortho/${open.id}`, body);
    expect(second.status).toBe(200);
    expect((await second.json() as { id: number }).id).toBe((await first.json() as { id: number }).id);
    const { rows } = await db.query(`SELECT 1 FROM ortho_adjustments WHERE case_id = $1 AND visit_id = $2`, [open.id, visit.id]);
    expect(rows).toHaveLength(1);
  });

  it("the duplicate-adjustments report is admin-only", async () => {
    expect((await authedGet("/api/reports?report=ortho-duplicate-adjustments&preset=today", h.sessions.admin)).status).toBe(200);
    for (const who of ["reception", "accountant", "doctorA"] as const) {
      const response = await authedGet("/api/reports?report=ortho-duplicate-adjustments&preset=today", h.sessions[who]);
      expect(response.status).toBe(403);
      expect(await messageOf(response)).toMatch(/[؀-ۿ]/);
    }
  });

  it("the read-only legacy audit is limited to admin and accountant", async () => {
    const path = "/api/reports?report=pre-system-receipts&preset=today";
    for (const who of ["admin", "accountant"] as const) {
      const response = await authedGet(path, h.sessions[who]);
      expect(response.status).toBe(200);
      const body = await response.json() as { result: { report: string; sections: unknown[] } };
      expect(body.result.report).toBe("pre-system-receipts");
      expect(body.result.sections.length).toBeGreaterThanOrEqual(6);
    }
    for (const who of ["reception", "doctorA", "cashier"] as const) {
      const response = await authedGet(path, h.sessions[who]);
      expect(response.status).toBe(403);
      expect(await messageOf(response)).toMatch(/[؀-ۿ]/);
    }
  });
});
