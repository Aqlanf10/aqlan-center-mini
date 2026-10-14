import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import type { TreatmentFinancialContext } from "../../lib/treatment-financial-context";

/** Built application + disposable PostgreSQL. SQL creates only synthetic read fixtures;
 * the invoice and historical agreement below use the real authenticated writers. */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let patientId = 0, foreignPatientId = 0, planId = 0, siblingId = 0, itemId = 0, visitId = 0, serviceId = 0;
async function id(sql: string, values: unknown[] = []) {
  return (await db.query<{ id: number }>(sql, values)).rows[0].id;
}
async function patient() {
  return id("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic invoice reference') RETURNING id", [randomUUID()]);
}
beforeAll(async () => {
  h = await harness();
  expect(new URL(baseUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).hostname).toBe("127.0.0.1");
  expect(new URL(h.seeded.dbUrl).pathname).toBe("/aqlan_sec_http");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false }); await db.connect();
  patientId = await patient(); foreignPatientId = await patient();
  const plan = () => id("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency) VALUES($1,'Synthetic existing plan',25250000,'SAR') RETURNING id", [patientId]);
  planId = await plan(); siblingId = await plan();
  visitId = await id("INSERT INTO visits(patient_id,patient_name) VALUES($1,'Synthetic reference visit') RETURNING id", [patientId]);
  itemId = await id("INSERT INTO plan_items(plan_id,service_name,unit_price_minor,visit_id) VALUES($1,'Synthetic planned work',25250000,$2) RETURNING id", [planId, visitId]);
  serviceId = await id("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'rct',300000,TRUE,TRUE) RETURNING id", [`Synthetic reader ${randomUUID()}`]);
}, 120000);
afterAll(async () => { await db?.end(); });
async function snapshot(target: number) {
  return (await db.query(`SELECT
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS invoices,
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS payments,
    (SELECT count(*)::int FROM treatment_plans WHERE patient_id=$1) AS plans,
    (SELECT count(*)::int FROM plan_items i JOIN treatment_plans p ON p.id=i.plan_id WHERE p.patient_id=$1) AS items,
    (SELECT count(*)::int FROM clinical_cases WHERE patient_id=$1) AS cases,
    (SELECT count(*)::int FROM patient_opening_balances WHERE patient_id=$1) AS openings`, [target])).rows[0];
}
async function financial(target: number) {
  const response = await authedGet(`/api/patients/${target}/treatment-financial-context`, h.sessions.admin);
  const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(200);
  expect(response.headers.get("cache-control")?.split(",").map(value => value.trim()).sort())
    .toEqual(["no-store", "private"]);
  return body as TreatmentFinancialContext;
}
describe("invoice reference readers through the built application", () => {
  it("resolves the recorded visit/item/plan and refuses sibling-plan and foreign-patient guesses without writes", async () => {
    const before = await snapshot(patientId);
    const path = `/api/patients/${patientId}/clinical-context`;
    const exact = await authedGet(`${path}?visitId=${visitId}&planItemId=${itemId}`, h.sessions.reception);
    expect(exact.status).toBe(200);
    expect(await exact.json()).toMatchObject({ context: { patientId, visitId, planId, planItemId: itemId } });
    const sibling = await authedGet(`${path}?visitId=${visitId}&planId=${siblingId}`, h.sessions.admin);
    expect(sibling.status).toBe(409); expect(await sibling.json()).toMatchObject({ reason: "context_mismatch" });
    expect((await authedGet(`/api/patients/${foreignPatientId}/clinical-context?planItemId=${itemId}`, h.sessions.admin)).status).toBe(404);
    for (const raw of [`0${patientId}`, `${patientId}e0`, "2147483648"]) {
      expect((await authedGet(`/api/patients/${raw}/clinical-context`, h.sessions.admin)).status).toBe(400);
    }
    expect(await snapshot(patientId)).toEqual(before);
  });
  it("keeps unbilled planned value out of the account debt and creates no financial documents", async () => {
    const before = await snapshot(patientId);
    const result = await financial(patientId);
    expect(result.plans).toContainEqual(expect.objectContaining({ planId, currency: "SAR", valueMinor: 25250000, valueIsDebt: false }));
    expect(result.documents).toEqual([]); expect(result.openingPositions).toEqual([]);
    expect(Object.values(result.accountPositions).every((position) => position.dueMinor === 0)).toBe(true);
    expect(await snapshot(patientId)).toEqual(before);
  });
  it("reads a real invoice's exact plan item and currency without manufacturing receipts", async () => {
    const target = await patient();
    const response = await authedMutation("/api/invoices", h.sessions.reception, "POST", JSON.stringify({
      patientId: target, currency: "YER", idempotencyKey: randomUUID(), items: [{ serviceId, toothCode: 36 }],
    }));
    const created = await response.json(); expect(response.status, JSON.stringify(created)).toBe(201);
    const before = await snapshot(target); const result = await financial(target);
    expect(result.documents).toHaveLength(1);
    expect(result.documents[0]).toMatchObject({ invoiceId: created.id, currency: "YER", netMinor: 300000, settlements: [] });
    expect(result.references).toHaveLength(1);
    expect(result.references[0]).toMatchObject({ patientId: target, planId: created.clinical.planId,
      planItemId: created.clinical.links[0].planItemId, clinicalCaseId: created.clinical.links[0].caseId, invoiceIds: [created.id] });
    expect(before.payments).toBe(0); expect(await snapshot(target)).toEqual(before);
  });
  it("reads historical 300000/120000 as one 180000 opening with no invoice or receipt", async () => {
    const target = await patient();
    const response = await authedMutation(`/api/patients/${target}/legacy-treatments`, h.sessions.reception, "POST", JSON.stringify({
      serviceId, toothCode: 36, currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000",
      historicalAsOf: "2026-09-30", idempotencyKey: randomUUID(),
    }));
    const created = await response.json(); expect(response.status, JSON.stringify(created)).toBe(201);
    const before = await snapshot(target); const result = await financial(target);
    expect(before).toMatchObject({ invoices: 0, payments: 0, openings: 1 });
    expect(result.documents).toEqual([]); expect(result.openingPositions).toHaveLength(1);
    expect(result.openingPositions[0]).toMatchObject({ currency: "YER", openingMinor: 180000, settledMinor: 0, remainingMinor: 180000 });
    expect(result.references[0].historicalAgreements[0]).toMatchObject({ agreedMinor: 300000, previouslyPaidMinor: 120000,
      remainingAtRegistrationMinor: 180000, currentAgreementRemainingMinor: null });
    expect(await snapshot(target)).toEqual(before);
  });
  it("does not grant financial access from clinical navigation or clinical access from finance roles", async () => {
    for (const session of [h.sessions.reception, h.sessions.cashier, h.sessions.accountant]) {
      const response = await authedGet(`/api/patients/${patientId}/treatment-financial-context`, session);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ patientId, documents: [] });
    }
    for (const session of [h.sessions.doctorA, h.sessions.portalA, { cookie: "", token: "" }]) {
      expect([401, 403]).toContain((await authedGet(`/api/patients/${patientId}/treatment-financial-context`, session)).status);
    }
    for (const session of [h.sessions.cashier, h.sessions.accountant, h.sessions.portalA, { cookie: "", token: "" }]) {
      expect([401, 403]).toContain((await authedGet(`/api/patients/${patientId}/clinical-context?planItemId=${itemId}`, session)).status);
    }
  });
});
