import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, harness } from "./_server";

/**
 * (CHAIR-1) الاستقبال ← الكرسي ← الشبّاك على التطبيق المبني: من يقرّ الجاهزية ومن يرى التفاصيل
 * الطبية والرصيد، وبوابة النداء بالإعداد مغلقًا ومفعَّلًا، والتأجيل وملخّص المغادرة — وكل رفضٍ
 * برسالة عربية بلا تفاصيل داخلية.
 */

let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0;
const stamp = Date.now();

type Who = "admin" | "reception" | "doctorA" | "doctorB" | "cashier" | "accountant";
const patch = (who: Who, visitId: number, body: unknown) =>
  authedMutation(`/api/visits/${visitId}`, h.sessions[who], "PATCH", JSON.stringify(body));
const jsonOf = async (response: Response) => await response.json() as Record<string, unknown>;
const INTERNALS = /(stack|error:|exception|postgres|relation |column |syntax|at \w+ \()/i;

async function expectCleanArabic(response: Response) {
  const text = await response.text();
  expect(text).not.toMatch(INTERNALS);
  const body = JSON.parse(text) as Record<string, unknown>;
  expect(String(body.message ?? "")).toMatch(/[؀-ۿ]/);
  return body;
}

async function newVisit(): Promise<number> {
  const { rows: [visit] } = await db.query<{ id: number }>(
    `INSERT INTO visits (patient_name, patient_id) VALUES ('مريض الكرسي', $1) RETURNING id`, [patientId]);
  return visit.id;
}

async function setGate(on: boolean) {
  await db.query(`INSERT INTO settings (key, value) VALUES ('ops.require_clearance_before_call', $1)
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [on ? "true" : "false"]);
}

let chairSeq = 20;
/* قيمة «clinic.chairs» قبل الاختبار — تُعاد كما كانت في afterAll: أربعون كرسيًّا تُبقي
   صفّ الانتظار عريضًا فيسقط اختبار عرض الهاتف الذي يليه في الجولة نفسها. */
let originalChairs: string | null = null;

beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const { rows: [doctor] } = await db.query<{ party_id: number }>(`SELECT party_id FROM users WHERE username = 'secdoctora'`);
  const { rows: [patient] } = await db.query<{ id: number }>(
    `INSERT INTO patients (patient_number, full_name, primary_doctor_id, medical_alert)
     VALUES ($1, 'مريض الجاهزية', $2, 'حساسية بنسلين') RETURNING id`,
    [`CH-${stamp}`, doctor.party_id]);
  patientId = patient.id;
  const { rows: chairsRows } = await db.query<{ value: string }>(`SELECT value FROM settings WHERE key = 'clinic.chairs'`);
  originalChairs = chairsRows[0]?.value ?? null;
  await db.query(`INSERT INTO settings (key, value) VALUES ('clinic.chairs', '40')
                  ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`);
}, 120_000);

afterAll(async () => {
  await setGate(false).catch(() => {});
  await (originalChairs === null
    ? db.query(`DELETE FROM settings WHERE key = 'clinic.chairs'`)
    : db.query(`UPDATE settings SET value = $1 WHERE key = 'clinic.chairs'`, [originalChairs])).catch(() => {});
  await db?.end();
});

describe("CHAIR-1 — readiness permissions and messages", () => {
  it("reception clears a visit; the clear is audited and the status is unchanged", async () => {
    const visitId = await newVisit();
    const response = await patch("reception", visitId, { action: "clear" });
    expect(response.status).toBe(200);
    expect(await jsonOf(response)).toMatchObject({ ok: true, clearedBy: expect.any(String), already: false });
    const { rows: [row] } = await db.query<{ status: string }>(`SELECT status FROM visits WHERE id = $1`, [visitId]);
    expect(row.status).toBe("waiting");
    const { rows } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'visit.clear' AND entity_id = $1`, [String(visitId)]);
    expect(rows).toHaveLength(1);
  });

  it("a doctor who does not own the patient cannot clear it (404, Arabic, no internals)", async () => {
    const visitId = await newVisit();
    const response = await patch("doctorB", visitId, { action: "clear" });
    expect(response.status).toBe(404);
    await expectCleanArabic(response);
  });

  it("cashier and accountant are outside the readiness routes", async () => {
    const visitId = await newVisit();
    for (const who of ["cashier", "accountant"] as const) {
      const read = await authedGet("/api/visits/readiness", h.sessions[who]);
      expect(read.status).toBe(403);
      await expectCleanArabic(read);
      expect((await patch(who, visitId, { action: "clear" })).status).toBe(403);
    }
  });

  it("the board read gives reception the checklist and dues; doctorB sees neither for doctorA's patient", async () => {
    const visitId = await newVisit();
    const reception = await jsonOf(await authedGet("/api/visits/readiness", h.sessions.reception));
    const mine = (reception.items as { visitId: number; checklist: unknown; balances: unknown }[]).find((row) => row.visitId === visitId);
    expect(mine?.checklist).toEqual(expect.arrayContaining([expect.objectContaining({ key: "alerts", state: "attention" })]));
    expect(Array.isArray(mine?.balances)).toBe(true);

    const other = await jsonOf(await authedGet("/api/visits/readiness", h.sessions.doctorB));
    const hidden = (other.items as { visitId: number; checklist: unknown; balances: unknown; alerts: unknown; historyAlerts: unknown }[]).find((row) => row.visitId === visitId);
    expect(hidden).toMatchObject({ checklist: null, alerts: null, historyAlerts: null, editableAlert: null, balances: null });

    const denied = await authedGet(`/api/visits/readiness?patientId=${patientId}`, h.sessions.doctorB);
    expect(denied.status).toBe(403);
    await expectCleanArabic(denied);
    const bad = await authedGet("/api/visits/readiness?patientId=abc", h.sessions.reception);
    expect(bad.status).toBe(400);
    await expectCleanArabic(bad);
  });

  it("the patient's own doctor without «مدفوعات مرضاي» sees the checklist but no balance and no «دفع» step", async () => {
    await newVisit();
    const body = await jsonOf(await authedGet(`/api/visits/readiness?patientId=${patientId}`, h.sessions.doctorA));
    const visit = body.visit as { checklist: unknown; balances: unknown; stepper: { steps: { key: string }[] } };
    expect(Array.isArray(visit.checklist)).toBe(true);
    expect(visit.balances).toBeNull();
    expect(visit.stepper.steps.map((step) => step.key)).not.toContain("paid");
  });
});

describe("CHAIR-1 — the ready-for-chair gate over HTTP", () => {
  it("setting off: an uncleared call succeeds with an Arabic warning", async () => {
    await setGate(false);
    const visitId = await newVisit();
    chairSeq += 1;
    const response = await patch("reception", visitId, { action: "call", chair: chairSeq });
    expect(response.status).toBe(200);
    expect(String((await jsonOf(response)).warning)).toMatch(/[؀-ۿ]/);
  });

  it("setting on: refused 409 with an Arabic message and a code; an emergency with a reason passes", async () => {
    await setGate(true);
    const visitId = await newVisit();
    chairSeq += 1;
    const refused = await patch("reception", visitId, { action: "seat", chair: chairSeq });
    expect(refused.status).toBe(409);
    const body = await expectCleanArabic(refused);
    expect(body.code).toBe("clearance_required");
    expect(Object.keys(body).sort()).toEqual(["code", "message"]);

    const noReason = await patch("reception", visitId, { action: "seat", chair: chairSeq, emergency: true, emergencyReason: "" });
    expect(noReason.status).toBe(409);
    expect((await expectCleanArabic(noReason)).code).toBe("emergency_reason_required");

    const bypass = await patch("reception", visitId, { action: "seat", chair: chairSeq, emergency: true, emergencyReason: "نزيف" });
    expect(bypass.status).toBe(200);
    const { rows } = await db.query(`SELECT 1 FROM audit_log WHERE action = 'visit.clearance_bypass' AND entity_id = $1`, [String(visitId)]);
    expect(rows).toHaveLength(1);
    await setGate(false);
  });
});

describe("CHAIR-1 — defer and walkout", () => {
  it("defer before sign is an Arabic 409; a doctor cannot defer (403)", async () => {
    const visitId = await newVisit();
    const early = await patch("reception", visitId, { action: "defer" });
    expect(early.status).toBe(409);
    await expectCleanArabic(early);
    const doctor = await patch("doctorA", visitId, { action: "defer" });
    expect(doctor.status).toBe(403);
    await expectCleanArabic(doctor);
  });

  it("the walkout is for money roles; a doctor without «مدفوعات مرضاي» gets an Arabic 403", async () => {
    const visitId = await newVisit();
    expect((await authedGet(`/api/visits/${visitId}/walkout`, h.sessions.reception)).status).toBe(200);
    const denied = await authedGet(`/api/visits/${visitId}/walkout`, h.sessions.doctorA);
    expect(denied.status).toBe(403);
    await expectCleanArabic(denied);
    const other = await authedGet(`/api/visits/${visitId}/walkout`, h.sessions.doctorB);
    expect(other.status).toBe(404);
    await expectCleanArabic(other);
  });

  it("an unknown action stays an Arabic 400 (existing actions unchanged)", async () => {
    const visitId = await newVisit();
    const response = await patch("reception", visitId, { action: "teleport" });
    expect(response.status).toBe(400);
    await expectCleanArabic(response);
  });
});
