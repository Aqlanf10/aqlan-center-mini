import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl } from "./_server";
import {
  createLinkedClinicalFixture, linkedClinicalSnapshot, openLinkedClinicalFixtures,
  type LinkedClinicalFixture,
} from "./_linked-clinical-fixtures";

/**
 * NEW AUTHORED UNRUN source for the current local rebuild, not a recovered test
 * or historical passing result. Root review/integration and runtime approval
 * are required. The existing _server harness is the only app/DB owner.
 * All operations address explicit synthetic linked visits. No auth mocks,
 * users/permissions/settings edits, schema changes, triggers or browser APIs.
 */
let context: Awaited<ReturnType<typeof openLinkedClinicalFixtures>>;
let f: LinkedClinicalFixture;
let alternateProvider = 0;
let pricedService = 0;
let manualService = 0;
let sequence = 0;
const stamp = Date.now();
const oldNotes = {
  chiefComplaint: "Synthetic original complaint", examination: "Synthetic original examination",
  diagnosis: "Synthetic original diagnosis", treatmentDone: "Synthetic original treatment",
  nextPlan: "Synthetic original next plan",
};
const newNotes = {
  chiefComplaint: "Synthetic replacement complaint", examination: "Synthetic replacement examination",
  diagnosis: "Synthetic replacement diagnosis", treatmentDone: "Synthetic replacement treatment",
  nextPlan: "Synthetic replacement next plan",
};
const storedNotes = (notes: typeof oldNotes) => ({
  chief_complaint: notes.chiefComplaint, examination: notes.examination, diagnosis: notes.diagnosis,
  treatment_done: notes.treatmentDone, next_plan: notes.nextPlan,
});
const path = () => `/api/visits/${f.visitId}/clinical`;
const snapshot = () => linkedClinicalSnapshot(context.db, f);
const line = (serviceId = pricedService, unitPriceMinor = 15000) => ({
  serviceId, doctorId: alternateProvider, toothCode: 17, surfaces: null,
  quantity: 1, unitPriceMinor, note: "Synthetic replacement procedure", planItemId: null,
});
const replacement = () => ({
  action: "save", ...newNotes, doctorId: alternateProvider, billingCurrency: "YER",
  procedures: [line()],
});
const save = (body: unknown, session = context.h.sessions.doctorA, headers: Record<string, string> = {}) =>
  authedMutation(path(), session, "POST", JSON.stringify(body), headers);

beforeAll(async () => {
  context = await openLinkedClinicalFixtures();
  // A synthetic provider is an ordinary treatment FK, not another login or a
  // permission grant. The authenticated actor remains the seeded doctor A.
  alternateProvider = (await context.db.query<{ id: number }>(
    `INSERT INTO parties (kind, name) VALUES ('doctor', $1) RETURNING id`,
    [`Synthetic linked draft provider ${stamp}`],
  )).rows[0].id;
  pricedService = (await context.db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_usd_minor, price_configured, is_active)
       VALUES ($1, 'cleaning', 15000, 12000, TRUE, TRUE) RETURNING id`,
    [`Synthetic linked draft priced service ${stamp}`],
  )).rows[0].id;
  manualService = (await context.db.query<{ id: number }>(
    `INSERT INTO services (name, category, price_minor, price_configured, is_active)
       VALUES ($1, 'cleaning', 0, FALSE, TRUE) RETURNING id`,
    [`Synthetic linked draft manual service ${stamp}`],
  )).rows[0].id;
}, 120_000);
beforeEach(async () => {
  f = await createLinkedClinicalFixture(context.db, context.doctorId, `NEW-DRAFT-HTTP-${stamp}-${++sequence}`);
  await context.db.query(
    `UPDATE visits SET chief_complaint = $2, examination = $3, diagnosis = $4,
       treatment_done = $5, next_plan = $6 WHERE id = $1`,
    [f.visitId, oldNotes.chiefComplaint, oldNotes.examination, oldNotes.diagnosis, oldNotes.treatmentDone, oldNotes.nextPlan],
  );
  await context.db.query(
    `INSERT INTO visit_procedures (visit_id, service_id, doctor_id, tooth_code, surfaces, quantity, unit_price_minor, note)
       VALUES ($1, $2, $4, 16, 'MO', 1, 12000, 'Synthetic original priced line'),
              ($1, $3, $4, 26, NULL, 2, 8000, 'Synthetic original manual line')`,
    [f.visitId, pricedService, manualService, f.doctorId],
  );
});
afterAll(async () => { await context?.db.end(); });

describe("new linked clinical draft HTTP atomicity", () => {
  it("invalid currency 400 preserves all notes, provider, currency, exact old lines and audits", async () => {
    const before = await snapshot();
    expect(before.procedures).toHaveLength(2);
    const response = await save({ ...replacement(), billingCurrency: "JPY" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ message: "عملة الزيارة غير صالحة." });
    expect(await snapshot()).toEqual(before);
  });

  it("a later unauthorized price rolls back an earlier valid manual line and currency replacement", async () => {
    const before = await snapshot();
    const response = await save({ ...replacement(), procedures: [
      line(manualService, 7000), { ...line(pricedService, 20000), priceReason: "Synthetic increase" },
    ] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "price_authority" });
    // The successful control below verifies that this same manual line is valid.
    // Equality covers old row IDs, all five notes, provider/currency, and audits.
    expect(await snapshot()).toEqual(before);
  });

  it("a missing plan item rolls back the complete command after an earlier valid manual line", async () => {
    const missingPlanItemId = 2147483647;
    expect((await context.db.query("SELECT id FROM plan_items WHERE id = $1", [missingPlanItemId])).rows).toEqual([]);
    const before = await snapshot();
    const response = await save({ ...replacement(), procedures: [
      line(manualService, 7000), { ...line(), planItemId: missingPlanItemId },
    ] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ message: "بند الخطة غير متاح لهذه الزيارة أو تغيّرت جلساته. حدّث الزيارة وراجع الإجراء." });
    expect(await snapshot()).toEqual(before);
  });

  it("a tokenless save commits all notes, provider, currency, exact replacement lines and override audit together", async () => {
    const before = await snapshot();
    const response = await save({ ...replacement(), procedures: [line(manualService, 7000), line()] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ...newNotes, patientId: f.patientId, doctorId: alternateProvider, billingCurrency: "YER" });
    const after = await snapshot();
    expect(after.visit).toEqual({ ...before.visit, ...storedNotes(newNotes), doctor_id: alternateProvider, billing_currency: "YER" });
    expect(after.procedures).toHaveLength(2);
    expect(after.procedures.map((row) => [row.service_id, row.doctor_id, row.tooth_code, row.quantity, row.unit_price_minor])).toEqual([
      [manualService, alternateProvider, 17, 1, 7000], [pricedService, alternateProvider, 17, 1, 15000],
    ]);
    const oldIds = before.procedures.map((row) => row.id);
    expect(after.procedures.every((row) => !oldIds.includes(row.id))).toBe(true);
    expect(after.clinicalAudits).toEqual([expect.objectContaining({
      action: "visit.price_override", actor: "secdoctora", actor_role: "doctor",
      details: expect.objectContaining({ العملة: "YER", النوع: "سعر يدوي لخدمة غير مسعّرة", السعر_المعتمد: 7000 }),
    })]);
    expect(after.invoices).toEqual([]);
    expect(after.payments).toEqual([]);
    const reload = await authedGet(path(), context.h.sessions.doctorA);
    expect(reload.status).toBe(200);
    expect(await reload.json()).toMatchObject({ ...newNotes, doctorId: alternateProvider, billingCurrency: "YER",
      procedures: [expect.objectContaining({ serviceId: manualService, unitPriceMinor: 7000 }),
        expect.objectContaining({ serviceId: pricedService, unitPriceMinor: 15000 })] });
  });

  it("notes-only keeps exact procedure rows, USD and the existing provider when doctorId is null", async () => {
    const before = await snapshot();
    const response = await save({ action: "save", ...newNotes, doctorId: null, billingCurrency: "YER" });
    expect(response.status).toBe(200);
    expect(await snapshot()).toEqual({ ...before, visit: { ...before.visit, ...storedNotes(newNotes) } });
  });

  it("an explicit empty procedures array clears lines while omitted currency preserves USD", async () => {
    const before = await snapshot();
    const response = await save({ action: "save", ...newNotes, doctorId: null, procedures: [] });
    expect(response.status).toBe(200);
    expect(await snapshot()).toEqual({ ...before, visit: { ...before.visit, ...storedNotes(newNotes) }, procedures: [] });
  });

  it("authentication, non-clinical roles and cookie CSRF cannot partially change a linked draft", async () => {
    const before = await snapshot();
    const body = JSON.stringify(replacement());
    expect((await fetch(`${baseUrl}${path()}`, { method: "POST", redirect: "manual",
      headers: { Origin: baseUrl, "Content-Type": "application/json" }, body })).status).toBe(401);
    for (const session of [context.h.sessions.reception, context.h.sessions.accountant, context.h.sessions.cashier]) {
      expect((await save(replacement(), session)).status).toBe(403);
      expect(await snapshot()).toEqual(before);
    }
    expect((await save(replacement(), context.h.sessions.doctorA, { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await fetch(`${baseUrl}${path()}`, { method: "POST", redirect: "manual",
      headers: { Cookie: context.h.sessions.doctorA.cookie, "Content-Type": "application/json" }, body })).status).toBe(403);
    expect(await snapshot()).toEqual(before);
  });

  it("a signed linked visit refuses all draft changes and preserves the complete signed snapshot", async () => {
    // Clear fixture procedures by the real save contract, then explicitly sign
    // its existing diagnosis. This avoids manufacturing any invoice or payment.
    expect((await save({ action: "save", ...oldNotes, doctorId: f.doctorId, procedures: [] })).status).toBe(200);
    const signed = await save({ action: "sign" });
    expect(signed.status).toBe(200);
    expect(await signed.json()).toMatchObject({ signedBy: "secdoctora", invoiceId: null, duesMinor: 0 });
    const before = await snapshot();
    expect(before.visit.signed_at).toEqual(expect.any(String));
    const rejected = await save(replacement());
    expect(rejected.status).toBe(409);
    expect(await rejected.json()).toMatchObject({ message: "الزيارة موقَّعة — لا تُعدَّل. أضف ملحقًا." });
    expect(await snapshot()).toEqual(before);
    expect(before.invoices).toEqual([]);
    expect(before.payments).toEqual([]);
  });
});
