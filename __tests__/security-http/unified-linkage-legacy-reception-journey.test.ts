import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { authedGet, authedMutation, baseUrl, harness } from "./_server";
import type { TreatmentFinancialContext } from "../../lib/treatment-financial-context";
import { assertStrategyCiBoundary } from "./_ortho-strategy-live-fixture";

/** Real built-app HTTP + disposable PostgreSQL 18. No mocked routes or schema reset.
 * Ordinary catalogue/person/shift fixture rows only; treatment, consent, visit,
 * signature, receipt and handoff are created by their existing HTTP writers.
 * This proves opening-backed historical care, NOT future invoice-backed installments.
 */
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let doctorId = 0;
let serviceId = 0;
const stamp = `unified-${Date.now()}`;
let serial = 0;
type Who = "reception" | "doctorA" | "admin";
type Agreement = { id: number; planId: number; planItemId: number; caseId: number; agreedMinor: number;
  previouslyPaidMinor: number; remainingMinor: number; openingEffect: string };
type Walkout = { visitId: number; patientId: number; signedAt: string; invoice: { id: number } | null;
  checkout: { previous: Record<string, number>; current: Record<string, number>;
    paymentsToday: unknown[]; openingPaidToday: unknown[] };
  summary: { currency: string; currentBalanceMinor: number }[];
  receptionHandoff?: { status: string; handledReason: string | null } };

beforeAll(async () => {
  // Check before harness login, DB connection and fixture writes. Do not erase Railway flags.
  assertStrategyCiBoundary();
  if (process.env.CI !== "true" || process.env.GITHUB_ACTIONS !== "true"
    || Object.keys(process.env).some(key => key.startsWith("RAILWAY_") && process.env[key])) {
    throw new Error("This acceptance journey is restricted to existing disposable GitHub CI PG18.");
  }
  expect(baseUrl).toBe("http://127.0.0.1:3217");
  h = await harness();
  const url = new URL(h.seeded.dbUrl);
  expect(url.protocol).toBe("postgresql:");
  expect(url.hostname).toBe("127.0.0.1");
  expect(url.port).toBe("5432");
  expect(url.pathname).toBe("/aqlan_sec_http");
  expect(decodeURIComponent(url.username)).toBe("ci");
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  const version = Number((await db.query("SHOW server_version_num")).rows[0].server_version_num);
  expect(version).toBeGreaterThanOrEqual(180000);
  expect(version).toBeLessThan(190000);
  doctorId = (await db.query<{ party_id: number }>("SELECT party_id FROM users WHERE username = 'secdoctora'")).rows[0].party_id;
  serviceId = (await db.query<{ id: number }>(`INSERT INTO services
    (name, category, price_minor, is_active, price_configured) VALUES ($1, 'rct', 300000, TRUE, TRUE) RETURNING id`,
  [`عصب قبول مترابط ${stamp}`])).rows[0].id;
  await db.query(`INSERT INTO cashier_shifts (opened_by, opening_yer, opening_sar, opening_usd)
    SELECT 'unified-linkage-fixture', 0, 0, 0 WHERE NOT EXISTS (SELECT 1 FROM cashier_shifts WHERE status = 'open')`);
}, 120_000);
afterAll(async () => { await db?.end(); });

async function q<T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, values)).rows as T[];
}
async function read<T>(path: string): Promise<T> {
  const response = await authedGet(path, h.sessions.reception);
  const body = await response.text();
  expect(response.status, `${path}: ${body}`).toBe(200);
  return JSON.parse(body) as T;
}
async function mutate<T>(who: Who, path: string, body: unknown, status: number,
  headers: Record<string, string> = {}): Promise<T> {
  const response = await authedMutation(path, h.sessions[who], "POST", JSON.stringify(body), headers);
  const text = await response.text();
  expect(response.status, `${path}: ${text}`).toBe(status);
  return JSON.parse(text) as T;
}
async function patient() {
  return (await q<{ id: number }>(`INSERT INTO patients (patient_number, full_name, primary_doctor_id)
    VALUES ($1, 'مريض قبول مترابط اصطناعي', $2) RETURNING id`, [`${stamp}-${++serial}`, doctorId]))[0].id;
}
async function historical(patientId: number, paid = "120000") {
  const request = { serviceId, toothCode: 36, currency: "YER", agreedAmount: "300000",
    previouslyPaidAmount: paid, historicalAsOf: "2026-09-30", idempotencyKey: `${stamp}-history-${patientId}` };
  const result = await mutate<{ agreement: Agreement }>("reception", `/api/patients/${patientId}/legacy-treatments`, request, 201);
  // A committed response can be lost: replay the exact operation, never create a replacement key.
  const replay = await mutate<{ agreement: Agreement; replayed: boolean }>("reception", `/api/patients/${patientId}/legacy-treatments`, request, 200);
  expect(replay).toMatchObject({ replayed: true, agreement: { id: result.agreement.id } });
  return result.agreement;
}
async function parity(patientId: number, visitId: number, expectedDue: number, collected: number, noFinancialSources: boolean) {
  const ledger = await read<{ invoices: unknown[]; payments: { amountMinor: number; openingCurrency: string | null }[];
    balances: Record<string, { dueMinor: number; billedMinor: number; collectedMinor: number; openingMinor: number }> }>(`/api/patients/${patientId}/ledger`);
  const workflow = await read<{ financial: { byCurrency: Record<string, { balanceMinor: number }> } }>(`/api/patients/${patientId}/workflow`);
  const walkout = await read<Walkout>(`/api/visits/${visitId}/walkout`);
  const financial = await read<TreatmentFinancialContext>(`/api/patients/${patientId}/treatment-financial-context`);
  expect(ledger.invoices).toEqual([]);
  expect(ledger.balances.YER).toMatchObject({ dueMinor: expectedDue, billedMinor: 0, collectedMinor: collected });
  expect(workflow.financial.byCurrency.YER.balanceMinor).toBe(expectedDue);
  expect(financial.accountPositions.YER.dueMinor).toBe(expectedDue);
  expect(financial.documents).toEqual([]);
  expect(financial.references).toHaveLength(1);
  expect(financial.references[0].historicalAgreements[0]).toMatchObject({
    agreedMinor: 300000, currentAgreementRemainingMinor: null, currentAgreementSettlementState: "not_allocated",
  });
  // A patient-currency opening is not silently apportioned to one historical agreement.
  for (const position of financial.openingPositions) {
    expect(position).toMatchObject({ currency: "YER", remainingMinor: expectedDue, scope: "patient_currency", allocationState: "not_allocated" });
  }
  expect(walkout.checkout.current.YER).toBe(expectedDue);
  expect(walkout.invoice).toBeNull();
  expect(walkout.visitId).toBe(visitId);
  expect(walkout.patientId).toBe(patientId);
  expect(walkout.signedAt).toBeTruthy();
  if (noFinancialSources) {
    // Fully paid before the system creates neither an opening nor current cash.
    // The canonical summary deliberately omits all-zero currency buckets.
    expect(expectedDue).toBe(0); expect(collected).toBe(0);
    expect(walkout.checkout.previous.YER).toBe(0);
    expect(walkout.checkout.current.YER).toBe(0);
    expect(walkout.checkout.paymentsToday).toEqual([]);
    expect(walkout.checkout.openingPaidToday).toEqual([]);
    expect(walkout.summary).toEqual([]);
    expect(ledger.payments).toEqual([]);
    expect(financial.openingPositions).toEqual([]);
    expect(await q(`SELECT id FROM payments WHERE patient_id = $1`, [patientId])).toEqual([]);
    expect(await q(`SELECT patient_id FROM patient_opening_balances WHERE patient_id = $1`, [patientId])).toEqual([]);
  } else {
    const yer = walkout.summary.filter(row => row.currency === "YER");
    expect(yer).toHaveLength(1);
    expect(yer[0].currentBalanceMinor).toBe(expectedDue);
  }
  expect(await q(`SELECT id FROM invoices WHERE patient_id = $1`, [patientId])).toEqual([]);
  const receipts = await q<{ total: string }>(`SELECT COALESCE(SUM(amount_minor), 0)::text AS total FROM payments
    WHERE patient_id = $1 AND opening_currency = 'YER' AND currency = 'YER' AND kind = 'payment'`, [patientId]);
  expect(Number(receipts[0].total)).toBe(collected);
  // Every actual receipt remains attached to a real cash shift; no historic-paid receipt is fabricated.
  expect(await q(`SELECT p.id FROM payments p LEFT JOIN cashier_shifts s ON s.id = p.shift_id
    WHERE p.patient_id = $1 AND s.id IS NULL`, [patientId])).toEqual([]);
  return walkout;
}
async function arriveSign(patientId: number, agreement: Agreement) {
  await mutate("reception", `/api/plans/${agreement.planId}/consent`, { note: "موافقة اصطناعية مستقلة عن المبلغ التاريخي" }, 201);
  const visit = await mutate<{ id: number; status: string }>("reception", "/api/visits",
    { patientId, patientName: "مريض قبول مترابط اصطناعي", doctorId }, 201);
  expect(visit.status).toBe("waiting");
  await mutate("doctorA", `/api/visits/${visit.id}/clinical`, {
    action: "save", doctorId, diagnosis: "متابعة عصب السن 36", treatmentDone: "جلسة مشمولة موثقة",
    procedures: [{ serviceId, toothCode: 36, surfaces: null, quantity: 1, unitPriceMinor: 0,
      doctorId, planItemId: agreement.planItemId, note: null, priceReason: null }],
  }, 200);
  const signed = await mutate<{ signedAt: string; invoiceId: number | null }>("doctorA", `/api/visits/${visit.id}/clinical`, { action: "sign" }, 200);
  expect(signed.signedAt).toBeTruthy();
  expect(signed.invoiceId).toBeNull();
  expect(await q(`SELECT plan_item_id FROM visit_procedures WHERE visit_id = $1`, [visit.id]))
    .toEqual([{ plan_item_id: agreement.planItemId }]);
  expect(await q(`SELECT case_id FROM plan_items WHERE id = $1`, [agreement.planItemId]))
    .toEqual([{ case_id: agreement.caseId }]);
  return visit.id;
}
async function collect(patientId: number, amount: number) {
  const body = { patientId, invoiceId: null, planId: null, openingCurrency: "YER", kind: "payment",
    currency: "YER", amount: String(amount), method: "cash", note: "تحصيل فعلي بعد التسجيل" };
  const headers = { "Idempotency-Key": `${stamp}-collect-${patientId}` };
  // Two simultaneous tabs submit the same operation key. One durable receipt, one replay.
  const responses = await Promise.all([0, 1].map(() => authedMutation("/api/payments", h.sessions.reception,
    "POST", JSON.stringify(body), headers)));
  expect(responses.map(response => response.status).sort()).toEqual([200, 201]);
  const receipts = await Promise.all(responses.map(response => response.json() as Promise<{ id: number }>));
  expect(receipts[0].id).toBe(receipts[1].id);
  const replay = await mutate<{ id: number }>("reception", "/api/payments", body, 200, headers);
  expect(replay.id).toBe(receipts[0].id);
  expect(await q(`SELECT id FROM payments WHERE patient_id = $1`, [patientId])).toEqual([{ id: replay.id }]);
}

describe("Unified linkage: historical care → real signature → reception decision", () => {
  it.each([
    { label: "partial collection", paid: "120000", collection: 30000, due: 150000 },
    { label: "full collection", paid: "120000", collection: 180000, due: 0 },
    { label: "defer collection", paid: "120000", collection: 0, due: 180000 },
    { label: "already paid before system", paid: "300000", collection: 0, due: 0 },
  ])("$label preserves the same treatment identity and accurate debt", async ({ paid, collection, due }) => {
    const patientId = await patient();
    const agreement = await historical(patientId, paid);
    const opening = 300000 - Number(paid);
    expect(agreement).toMatchObject({ agreedMinor: 300000, previouslyPaidMinor: Number(paid), remainingMinor: opening });
    expect(await q(`SELECT id FROM payments WHERE patient_id = $1`, [patientId])).toEqual([]);
    const visitId = await arriveSign(patientId, agreement);
    const exact = await read<{ ok: boolean; context: Record<string, unknown>; sub: string }>(
      `/api/patients/${patientId}/clinical-context?planItemId=${agreement.planItemId}&visitId=${visitId}`);
    expect(exact).toMatchObject({ ok: true, sub: "endo", context: { patientId, visitId,
      planId: agreement.planId, planItemId: agreement.planItemId, clinicalCaseId: agreement.caseId } });
    await parity(patientId, visitId, opening, 0, opening === 0);
    if (collection) await collect(patientId, collection);
    const before = await parity(patientId, visitId, due, collection, opening === 0);
    const reason = collection === 0 && due > 0 ? "تأجيل التحصيل مع بقاء الدين" : "مراجعة الاستقبال مع حفظ الرصيد الفعلي";
    const body = { patientId, signedAt: before.signedAt, reason };
    // Wrong-patient handoff is rejected before it can hide an unrelated visit.
    await mutate("reception", `/api/visits/${visitId}/reception-handoff`, { ...body, patientId: h.seeded.patientBId }, 409);
    await mutate("doctorA", `/api/visits/${visitId}/reception-handoff`, body, 403);
    await mutate("reception", `/api/visits/${visitId}/reception-handoff`, body, 200);
    await mutate("reception", `/api/visits/${visitId}/reception-handoff`, body, 200);
    const after = await parity(patientId, visitId, due, collection, opening === 0);
    expect(after.receptionHandoff).toMatchObject({ status: "handled", handledReason: reason });
    expect(await q(`SELECT id FROM patient_opening_balance_history WHERE patient_id = $1`, [patientId]))
      .toHaveLength(opening > 0 ? 1 : 0);
    expect(await q(`SELECT id FROM legacy_treatment_agreements WHERE patient_id = $1`, [patientId])).toHaveLength(1);
  });
});
