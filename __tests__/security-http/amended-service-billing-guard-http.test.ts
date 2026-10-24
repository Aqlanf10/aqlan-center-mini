import { afterAll, beforeAll, expect, it } from "vitest";
import { Client } from "pg";
import { authedMutation, baseUrl, harness } from "./_server";

// Real built application, authenticated HTTP and private synthetic PostgreSQL.
// No session mock, browser interception, or financial writer substitution.
let h: Awaited<ReturnType<typeof harness>>;
let db: Client;
let serial = 0;
const q = async (sql: string, values: unknown[] = []) => (await db.query(sql, values)).rows;
beforeAll(async () => {
  h = await harness();
  db = new Client({ connectionString: h.seeded.dbUrl, ssl: false });
  await db.connect();
  await q("INSERT INTO cashier_shifts(opened_by) SELECT 'secadmin' WHERE NOT EXISTS(SELECT 1 FROM cashier_shifts WHERE status='open')");
});
afterAll(async () => { await db?.end(); });
const get = (path: string, role: "admin" | "doctorA" = "admin") => fetch(`${baseUrl}${path}`, { headers: { Cookie: h.sessions[role].cookie } });
const post = (path: string, body: unknown, role: "admin" | "doctorA" = "admin", headers: Record<string, string> = {}) =>
  authedMutation(path, h.sessions[role], "POST", JSON.stringify(body), headers);
async function fixture() {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic amended HTTP patient') RETURNING id", [`AS-HTTP-${Date.now()}-${++serial}`]);
  const [doctor] = await q("SELECT party_id id FROM users WHERE username='secdoctora'");
  const [metal] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic metal HTTP','crown',500000,TRUE,TRUE) RETURNING id");
  const [zircon] = await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic zircon HTTP','crown',800000,TRUE,TRUE) RETURNING id");
  // Pre-existing consented clinical plan is fixture data. Approval, collection,
  // amendment, clinical draft and signature all use real authenticated routes.
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,consent_at,consent_by,primary_doctor_id) VALUES($1,'Synthetic approved HTTP work',500000,'YER','2026-10-01',now(),'secadmin',$2) RETURNING id", [patient.id, doctor.id]);
  const [item] = await q("INSERT INTO plan_items(plan_id,service_id,service_name,tooth_code,quantity,unit_price_minor,doctor_id,billing_rule,session_count) VALUES($1,$2,'Synthetic metal HTTP',36,1,500000,$3,'once',1) RETURNING id", [plan.id, metal.id, doctor.id]);
  const approval = await post(`/api/plans/${plan.id}/financial-approval`, { expectedTotalMinor: 500000, currency: "YER", source: { kind: "new" }, reason: "Synthetic original approval" }, "admin", { "Idempotency-Key": `as-http-approval-${plan.id}` });
  expect(approval.status, await approval.clone().text()).toBe(201);
  const paid = await post(`/api/plans/${plan.id}`, { amount: "180000", currency: "YER" }, "admin", { "Idempotency-Key": `as-http-paid-${plan.id}` });
  expect(paid.status, await paid.clone().text()).toBe(201);
  const preview = await get(`/api/plans/${plan.id}/agreement-amendment`);
  expect(preview.status).toBe(200);
  const source = await preview.json();
  const amended = await post(`/api/plans/${plan.id}/agreement-amendment`, { idempotencyKey: `as-http-upgrade-${plan.id}`, expectedSourceHash: source.sourceHash, newServiceId: zircon.id, newUnitMinor: 800000, reason: "Synthetic agreed financial upgrade" });
  expect(amended.status, await amended.clone().text()).toBe(201);
  expect(await amended.json()).toMatchObject({ revisedAgreementMinor: 800000, deltaMinor: 300000, remainingMinor: 620000 });
  return { patientId: patient.id as number, doctorId: doctor.id as number, planId: plan.id as number, itemId: item.id as number, zirconId: zircon.id as number };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function draft(f: Fixture, planItemId: number | null, tooth = 36) {
  const [visit] = await q("INSERT INTO visits(patient_id,patient_name,doctor_id) VALUES($1,'Synthetic HTTP draft',$2) RETURNING id", [f.patientId, f.doctorId]);
  const saved = await post(`/api/visits/${visit.id}/clinical`, { action: "save", doctorId: f.doctorId, diagnosis: "Synthetic diagnosis", treatmentDone: "Synthetic factual draft", billingCurrency: "YER", procedures: [{ serviceId: f.zirconId, toothCode: tooth, surfaces: null, quantity: 1, unitPriceMinor: 800000, doctorId: f.doctorId, planItemId, note: "Synthetic HTTP procedure" }] });
  expect(saved.status, await saved.clone().text()).toBe(200);
  return { id: visit.id as number, saved: await saved.json() };
}
async function footprint(f: Fixture, visitId: number) {
  return (await q(`SELECT
    (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM invoices i WHERE patient_id=$1) invoices,
    (SELECT jsonb_agg(to_jsonb(ii) ORDER BY ii.id) FROM invoice_items ii JOIN invoices inv ON inv.id=ii.invoice_id WHERE inv.patient_id=$1) invoice_items,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM payments p WHERE patient_id=$1) payments,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM agreement_delta_amendments a WHERE patient_id=$1) amendments,
    (SELECT to_jsonb(v) FROM visits v WHERE id=$2) visit,
    (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM visit_procedures p WHERE visit_id=$2) procedures,
    (SELECT jsonb_agg(to_jsonb(s) ORDER BY id) FROM treatment_sessions s WHERE visit_id=$2) sessions,
    (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM tooth_conditions c WHERE visit_id=$2) chart,
    (SELECT jsonb_agg(to_jsonb(l) ORDER BY id) FROM lab_orders l WHERE visit_id=$2) labs,
    (SELECT jsonb_agg(to_jsonb(m) ORDER BY id) FROM inventory_movements m WHERE visit_id=$2) stock,
    (SELECT jsonb_agg(to_jsonb(a) ORDER BY id) FROM audit_log a) audit`, [f.patientId, visitId]))[0];
}
it("real authenticated save and doctor GET expose the blocking flag; sign refuses with all saved state unchanged", async () => {
  const f = await fixture();
  const visit = await draft(f, null);
  expect(visit.saved.amendedServiceConflict).toBe(true);
  const response = await get(`/api/visits/${visit.id}/clinical`, "doctorA");
  expect(response.status, await response.clone().text()).toBe(200);
  const view = await response.json();
  expect(view.amendedServiceConflict).toBe(true);
  expect(view.planWarning).toContain("استقلال هذا العمل عن تغطيته غير متحقق");
  expect(view.planWarning).toContain("ربط الخدمة المعدلة سريريًا غير مدعوم");
  expect(view.planWarning).not.toMatch(/500000|180000|300000|620000/);
  expect(view).not.toHaveProperty("amendment");
  const before = await footprint(f, visit.id);
  const signed = await post(`/api/visits/${visit.id}/clinical`, { action: "sign" }, "doctorA");
  expect(signed.status, await signed.clone().text()).toBe(409);
  expect((await signed.json()).message).toContain("ربط الخدمة المعدلة سريريًا غير مدعوم");
  expect(await footprint(f, visit.id)).toEqual(before);
  expect(before.invoices).toHaveLength(2);
  expect(before.invoices.reduce((n: number, i: { total_minor: number; discount_minor: number }) => n + Number(i.total_minor) - Number(i.discount_minor), 0)).toBe(800000);
  expect(before.payments).toHaveLength(1);
  expect(Number(before.payments[0].amount_minor)).toBe(180000);
  expect(before.amendments).toHaveLength(1);
});
it.each([36, 46])("explicit independent linked work on tooth %i keeps its normal authenticated billing policy", async (tooth) => {
  const f = await fixture();
  const [plan] = await q("INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,start_date,consent_at,consent_by,primary_doctor_id) VALUES($1,'Synthetic independent authorized work',800000,'YER','2026-10-01',now(),'secadmin',$2) RETURNING id", [f.patientId, f.doctorId]);
  const [item] = await q("INSERT INTO plan_items(plan_id,service_id,service_name,tooth_code,quantity,unit_price_minor,doctor_id,billing_rule,session_count) VALUES($1,$2,'Synthetic zircon HTTP',$3,1,800000,$4,'on_completion',1) RETURNING id", [plan.id, f.zirconId, tooth, f.doctorId]);
  const visit = await draft(f, item.id, tooth);
  expect(visit.saved.amendedServiceConflict).toBe(false);
  const response = await get(`/api/visits/${visit.id}/clinical`, "doctorA");
  expect(response.status).toBe(200);
  expect((await response.json()).amendedServiceConflict).toBe(false);
  const signed = await post(`/api/visits/${visit.id}/clinical`, { action: "sign" }, "doctorA");
  expect(signed.status, await signed.clone().text()).toBe(200);
  expect((await signed.json()).duesMinor).toBe(800000);
  const after = await footprint(f, visit.id);
  expect(after.invoices).toHaveLength(3);
  expect(after.payments).toHaveLength(1);
  expect(after.amendments).toHaveLength(1);
});

it("registered but unavailable amendment history never becomes authenticated ready-to-sign evidence", async () => {
  const f = await fixture();
  const visit = await draft(f, null);
  const before = await footprint(f, visit.id);
  expect(await q("SELECT version FROM schema_migrations WHERE version='0066'")).toHaveLength(1);
  await q("ALTER TABLE agreement_delta_amendments RENAME TO boundary_http_unavailable_amendments");
  try {
    const response = await get(`/api/visits/${visit.id}/clinical`, "doctorA");
    expect(response.status).toBe(500);
    expect(await response.json()).not.toHaveProperty("amendedServiceConflict");
    const signing = await post(`/api/visits/${visit.id}/clinical`, { action: "sign" }, "doctorA");
    expect(signing.status).toBe(500);
  } finally {
    await q("ALTER TABLE boundary_http_unavailable_amendments RENAME TO agreement_delta_amendments");
  }
  expect(await footprint(f, visit.id)).toEqual(before);
});
