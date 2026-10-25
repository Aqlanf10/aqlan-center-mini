import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
import { Client } from "pg";
import { assertRealPostgresUrl, createIsolatedDatabase, stubPostgresEnv } from "./_setup";
import type { SessionPayload } from "../../lib/auth";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { applyRuntimeMigrationFiles, loadMigrationFiles } from "../../lib/migrations";

// Synthetic diagnostic only: real PostgreSQL and real financial/clinical writers.
// The session seam is the only mock. No network server/browser claim is made.
assertRealPostgresUrl();
stubPostgresEnv();
process.env.DATABASE_URL = await createIsolatedDatabase("aqlan_amended_service_boundary_witness_test");
let session: SessionPayload;
vi.mock("../../lib/session", async original => ({ ...await original<typeof import("../../lib/session")>(), requireSession: async () => session }));
const db = await import("../../lib/db");
const auth = await import("../../lib/auth");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { approveAgreement, collectApprovedAgreement, approvedAgreementPosition } = await import("../../lib/approved-agreements");
const amendmentRoute = await import("../../app/api/plans/[id]/agreement-amendment/route");
const clinicalRoute = await import("../../app/api/visits/[id]/clinical/route");
const previewRoute = await import("../../app/api/visits/[id]/billing-preview/route");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
const context = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });
const post = (url: string, body: unknown) => new Request(`http://localhost${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
let serial = 0;
const observations: Record<string, unknown> = { diagnosticBaselineHead: "c998b435306f8295a217e49f20080293c479c359", syntheticOnly: true, transport: "direct real route handlers, session seam mocked" };
beforeAll(async () => {
  await db.ensureSchema();
  await applyRuntimeMigrationFiles(db.getPool(), (await loadMigrationFiles()).filter(file => file.version === "0066"));
  const hash = await auth.hashPassword("synthetic-boundary-only-password");
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES('boundary-admin','Synthetic boundary admin',$1,'admin',TRUE) RETURNING id", [hash]);
  session = { userId: user.id, username: "boundary-admin", role: "admin", credentialVersion: auth.sessionCredentialVersion(hash), expiresAt: Date.now() + 3600000 };
  await db.openShift({ openedBy: session.username, opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180000);
afterAll(async () => {
  // Optional local diagnostic export only; fresh CI must not depend on a
  // scratch directory outside the checkout or treat the baseline as final SHA.
  if (process.env.AQLAN_BOUNDARY_WITNESS_OUTPUT) {
    await writeFile(process.env.AQLAN_BOUNDARY_WITNESS_OUTPUT, JSON.stringify(observations, null, 2));
  }
  await db.resetPoolForTesting();
});

async function fixture(amendService: "new" | "original" = "new", withoutCase = false) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic boundary patient') RETURNING id", [`BOUNDARY-${++serial}`]);
  const [doctor] = await q("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic boundary provider') RETURNING id");
  const [metal] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic metal crown',500000,TRUE,TRUE,'crown') RETURNING id");
  const [zircon] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic zirconia crown',800000,TRUE,TRUE,'crown') RETURNING id");
  const created = await createLinkedInvoice({ patientId: patient.id, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: session.username, actorRole: "admin", items: [{ serviceId: metal.id, category: "crown", doctorId: doctor.id, description: "Synthetic metal crown", quantity: 1, unitPriceMinor: 500000, toothCode: 36, caseId: null, sessions: null, surfaces: null, episodeTeeth: null, scope: null }], templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {} });
  if (!created.ok || created.planId === null) throw Error(`Fixture invoice failed: ${JSON.stringify(created)}`);
  if (withoutCase) await q("UPDATE plan_items SET case_id=NULL WHERE plan_id=$1", [created.planId]);
  expect(await db.recordPlanConsent({ planId: created.planId, actor: session.username, note: "Synthetic initial clinical consent" })).toMatchObject({ ok: true });
  await approveAgreement({ planId: created.planId, expectedTotalMinor: 500000, currency: "YER", source: { kind: "invoice", invoiceId: created.invoice.id }, reason: "Synthetic approval", idempotencyKey: `boundary-approval-${serial}`, session });
  const receipt = await collectApprovedAgreement({ planId: created.planId, amountMinor: 180000, currency: "YER", method: "cash", note: "Synthetic receipt", idempotencyKey: `boundary-payment-${serial}`, session });
  const [item] = await q("SELECT id,case_id FROM plan_items WHERE plan_id=$1", [created.planId]);
  const f = { patientId: patient.id as number, doctorId: doctor.id as number, planId: created.planId, itemId: item.id as number, caseId: item.case_id as number | null, invoiceId: created.invoice.id, paymentId: receipt.paymentId, metalId: metal.id as number, zirconId: zircon.id as number };
  const immutableBefore = await immutableHistory(f);
  const before = await money(f);
  const viewResponse = await amendmentRoute.GET(new Request(`http://localhost/api/plans/${f.planId}/agreement-amendment`), context(f.planId));
  expect(viewResponse.status).toBe(200);
  const view = await viewResponse.json();
  const amendmentResponse = await amendmentRoute.POST(post(`/api/plans/${f.planId}/agreement-amendment`, { idempotencyKey: `boundary-upgrade-${serial}`, expectedSourceHash: view.sourceHash, newServiceId: amendService === "new" ? f.zirconId : f.metalId, newUnitMinor: 800000, reason: "Synthetic documented financial upgrade consent" }), context(f.planId));
  const amendment = await amendmentResponse.json();
  expect(amendmentResponse.status, JSON.stringify(amendment)).toBe(201);
  expect(amendment).toMatchObject({ previousAgreementMinor: 500000, deltaMinor: 300000, revisedAgreementMinor: 800000, settledMinor: 180000, remainingMinor: 620000, cashMovementMinor: 0 });
  expect(await immutableHistory(f)).toEqual(immutableBefore);
  expect(await money(f)).toMatchObject({ invoiceCount: 2, invoiceTotal: 800000, paymentCount: 1, paymentTotal: 180000, amendmentCount: 1, amendmentTotal: 300000, dueMinor: 620000 });
  return { ...f, immutableBefore, before, amendment, afterAmendment: await money(f) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function immutableHistory(f: { planId: number; invoiceId: number; paymentId: number }) {
  return {
    invoice: await q("SELECT to_jsonb(i) row FROM invoices i WHERE id=$1", [f.invoiceId]),
    invoiceItems: await q("SELECT to_jsonb(i) row FROM invoice_items i WHERE invoice_id=$1 ORDER BY id", [f.invoiceId]),
    plan: await q("SELECT to_jsonb(p) row FROM treatment_plans p WHERE id=$1", [f.planId]),
    planItems: await q("SELECT to_jsonb(i) row FROM plan_items i WHERE plan_id=$1 ORDER BY id", [f.planId]),
    approval: await q("SELECT to_jsonb(a) row FROM approved_agreement_principals a WHERE plan_id=$1", [f.planId]),
    payment: await q("SELECT to_jsonb(p) row FROM payments p WHERE id=$1", [f.paymentId]),
  };
}
async function money(f: { patientId: number; planId: number }) {
  const [totals] = await q(`SELECT
    (SELECT count(*)::int FROM invoices WHERE patient_id=$1) AS "invoiceCount",
    (SELECT coalesce(sum(total_minor-discount_minor),0)::int FROM invoices WHERE patient_id=$1 AND status<>'cancelled') AS "invoiceTotal",
    (SELECT count(*)::int FROM payments WHERE patient_id=$1) AS "paymentCount",
    (SELECT coalesce(sum(amount_minor),0)::int FROM payments WHERE patient_id=$1) AS "paymentTotal",
    (SELECT count(*)::int FROM agreement_delta_amendments WHERE plan_id=$2) AS "amendmentCount",
    (SELECT coalesce(sum(delta_minor),0)::int FROM agreement_delta_amendments WHERE plan_id=$2) AS "amendmentTotal"`, [f.patientId, f.planId]);
  return { ...totals, dueMinor: (await db.computeDebtRows([f.patientId])).find(row => row.currency === "YER")?.dueMinor ?? 0 };
}
async function visit(f: Fixture, caseId: number | null = f.caseId) {
  const created = await db.addVisit({ patientName: "Synthetic boundary patient", patientPhone: null, note: "Synthetic only", patientId: f.patientId, doctorId: f.doctorId });
  // Only fixture context assignment is SQL: the clinical save and sign are actual API handlers.
  await q("UPDATE visits SET case_id=$2 WHERE id=$1", [created.id, caseId]);
  return created.id;
}
async function save(f: Fixture, visitId: number, planItemId: number | null, tooth = 36, serviceId = f.zirconId) {
  const response = await clinicalRoute.POST(post(`/api/visits/${visitId}/clinical`, { action: "save", doctorId: f.doctorId, diagnosis: "Synthetic crown treatment", treatmentDone: "Synthetic clinical record", billingCurrency: "YER", procedures: [{ serviceId, toothCode: tooth, surfaces: null, quantity: 1, unitPriceMinor: serviceId === f.metalId ? 500000 : 800000, doctorId: f.doctorId, planItemId, note: "Synthetic witness" }] }), context(visitId));
  return { status: response.status, body: await response.json() };
}
async function sign(visitId: number) {
  const response = await clinicalRoute.POST(post(`/api/visits/${visitId}/clinical`, { action: "sign" }), context(visitId));
  return { status: response.status, body: await response.json() };
}

it("refuses upgraded same-context execution without creating another full-price debt", async () => {
  const f = await fixture();
  const [material] = await q("INSERT INTO inventory_items(name,unit,created_by) VALUES('Synthetic crown material','unit',$1) RETURNING id", [session.username]);
  await q("INSERT INTO inventory_movements(item_id,kind,qty,reason,created_by) VALUES($1,'in',10,'Synthetic initial stock',$2)", [material.id, session.username]);
  await q("INSERT INTO service_materials(service_id,item_id,qty_per_unit,created_by) VALUES($1,$2,1,$3)", [f.zirconId, material.id, session.username]);
  const visitId = await visit(f);
  const linked = await save(f, visitId, f.itemId);
  expect(linked.status).toBe(409);
  expect(await money(f)).toEqual(f.afterAmendment);
  expect(await q("SELECT id FROM visit_procedures WHERE visit_id=$1", [visitId])).toHaveLength(0);
  const unlinked = await save(f, visitId, null);
  expect(unlinked.status).toBe(200);
  expect(unlinked.body.amendedServiceConflict).toBe(true);
  expect((await (await clinicalRoute.GET(new Request("http://localhost"), context(visitId))).json()).amendedServiceConflict).toBe(true);
  expect(unlinked.body.planWarning).toContain("ربط الخدمة المعدلة سريريًا غير مدعوم حاليًا");
  const savedDraft = await q("SELECT to_jsonb(v) row FROM visits v WHERE id=$1", [visitId]);
  const savedProcedures = await q("SELECT to_jsonb(p) row FROM visit_procedures p WHERE visit_id=$1 ORDER BY id", [visitId]);
  const savedAudit = await q("SELECT to_jsonb(a) row FROM audit_log a ORDER BY id");
  const savedStock = await q("SELECT to_jsonb(m) row FROM inventory_movements m WHERE item_id=$1 ORDER BY id", [material.id]);
  const previewResponse = await previewRoute.GET(new Request(`http://localhost/api/visits/${visitId}/billing-preview`), context(visitId));
  const preview = { status: previewResponse.status, body: await previewResponse.json() };
  const result = await sign(visitId);
  const after = await money(f);
  const historyUnchanged = JSON.stringify(await immutableHistory(f)) === JSON.stringify(f.immutableBefore);
  const event = await q("SELECT plan_item_id,new_service_id,delta_minor::int FROM agreement_delta_amendments WHERE plan_id=$1", [f.planId]);
  const signedLines = await q("SELECT i.id,i.total_minor::int,ii.source_type,ii.source_id,ii.plan_item_id,ii.service_id FROM invoices i JOIN invoice_items ii ON ii.invoice_id=i.id WHERE i.patient_id=$1 ORDER BY i.id,ii.id", [f.patientId]);
  observations.sameContext = { identifiers: { patientId: f.patientId, planId: f.planId, itemId: f.itemId, caseId: f.caseId, toothCode: 36, metalId: f.metalId, zirconId: f.zirconId, visitId }, before: f.before, afterAmendment: f.afterAmendment, amendment: f.amendment, linked, unlinkedSaveStatus: unlinked.status, preview, sign: result, after, originalHistoryUnchanged: historyUnchanged, agreementPosition: await approvedAgreementPosition(f.planId, "2026-10-24"), event, signedLines };
  console.log("AMENDED_SERVICE_BOUNDARY", JSON.stringify({ linked: linked.status, unlinked: unlinked.status, preview: preview.body, signStatus: result.status, createdInvoiceId: result.body.createdInvoiceId, before: f.afterAmendment, after, originalHistoryUnchanged: historyUnchanged }));
  expect(historyUnchanged).toBe(true);
  expect(result.status, "Same amended work needs an explicit clinical identity review, never a new full bill").toBe(409);
  expect(result.body.message).toContain("ربط الخدمة المعدلة سريريًا غير مدعوم حاليًا");
  expect(result.body.message).not.toContain("اربطه ببنده الأصلي");
  expect(after).toEqual(f.afterAmendment);
  expect(await q("SELECT to_jsonb(v) row FROM visits v WHERE id=$1", [visitId])).toEqual(savedDraft);
  expect(await q("SELECT to_jsonb(p) row FROM visit_procedures p WHERE visit_id=$1 ORDER BY id", [visitId])).toEqual(savedProcedures);
  expect(await q("SELECT to_jsonb(a) row FROM audit_log a ORDER BY id")).toEqual(savedAudit);
  expect(await q("SELECT signed_at FROM visits WHERE id=$1", [visitId])).toEqual([{ signed_at: null }]);
  expect(await q("SELECT id FROM treatment_sessions WHERE visit_id=$1 AND status='done'", [visitId])).toHaveLength(0);
  expect(await q("SELECT id FROM tooth_conditions WHERE visit_id=$1", [visitId])).toHaveLength(0);
  expect(await q("SELECT id FROM lab_orders WHERE visit_id=$1", [visitId])).toHaveLength(0);
  expect(await q("SELECT to_jsonb(m) row FROM inventory_movements m WHERE item_id=$1 ORDER BY id", [material.id])).toEqual(savedStock);
});

it("holds different-tooth unlinked work when ordinary amendment coverage has no immutable scope", async () => {
  const f = await fixture();
  const createdCase = await db.createClinicalCase({ patientId: f.patientId, specialty: "prosthodontics", title: "Synthetic independent tooth 46 crown", site: "46", problem: "Synthetic separate tooth", responsiblePartyId: f.doctorId, orthoCaseId: null, actor: session.username });
  if (!createdCase.ok) throw Error(createdCase.reason);
  const visitId = await visit(f, createdCase.case.id);
  const saved = await save(f, visitId, null, 46);
  expect(saved.status).toBe(200);
  expect(saved.body.amendedServiceConflict).toBe(true);
  expect(saved.body.planWarning).toContain("استقلال هذا العمل عن تغطيته غير متحقق");
  const before = await signFootprint(f.patientId, visitId);
  const result = await sign(visitId);
  observations.differentTooth = { patientId: f.patientId, priorTooth: 36, newTooth: 46, priorCaseId: f.caseId, newCaseId: createdCase.case.id, saveStatus: saved.status, signStatus: result.status, duesMinor: result.body.duesMinor, after: await money(f) };
  expect(result.status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
  expect(await money(f)).toEqual(f.afterAmendment);
  expect(await immutableHistory(f)).toEqual(f.immutableBefore);
});

it("control: the existing guard already refuses original-service unlinked execution in the same context", async () => {
  const f = await fixture();
  const visitId = await visit(f);
  const saved = await save(f, visitId, null, 36, f.metalId);
  expect(saved.status).toBe(200);
  const result = await sign(visitId);
  observations.originalServiceProtection = { patientId: f.patientId, caseId: f.caseId, toothCode: 36, serviceId: f.metalId, saveStatus: saved.status, sign: result, after: await money(f) };
  expect(result.status).toBe(409);
  expect(result.body.sessionConflicts).toHaveLength(1);
  expect(await money(f)).toEqual(f.afterAmendment);
  expect(await immutableHistory(f)).toEqual(f.immutableBefore);
});

it.each([36, 46])("control: explicitly separate new linked work on tooth %i remains billable", async (tooth) => {
  const f = await fixture();
  const createdCase = await db.createClinicalCase({ patientId: f.patientId, specialty: "prosthodontics", title: "Synthetic independently authorized new crown work", site: String(tooth), problem: "Synthetic distinct new-work episode", responsiblePartyId: f.doctorId, orthoCaseId: null, actor: session.username });
  if (!createdCase.ok) throw Error(createdCase.reason);
  const newPlan = await db.createPlanV2({ patientId: f.patientId, title: "Synthetic independent new work", specialty: null, primaryDoctorId: f.doctorId, billingMode: "per_procedure", baseCurrency: "YER", startDate: "2026-10-24", note: "Synthetic separate treatment authorization, not the upgraded original work", createdBy: session.username, items: [{ serviceId: f.zirconId, serviceName: "Synthetic zirconia crown", category: "crown", toothCode: tooth, surfaces: null, quantity: 1, unitPriceMinor: 800000, billingRule: "on_completion", sessionCount: 1, note: "Explicit independent work" }], installments: [] });
  if (!newPlan.ok) throw Error(newPlan.message);
  const [newItem] = await q("SELECT id FROM plan_items WHERE plan_id=$1", [newPlan.planId]);
  expect(await db.setPlanItemCase({ itemId: newItem.id, caseId: createdCase.case.id, priority: null, actor: session.username })).toEqual({ ok: true });
  expect(await db.recordPlanConsent({ planId: newPlan.planId, actor: session.username, note: "Synthetic consent for independent new work" })).toMatchObject({ ok: true });
  const visitId = await visit(f, createdCase.case.id);
  const saved = await save(f, visitId, newItem.id, tooth);
  expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  expect(saved.body.amendedServiceConflict).toBe(false);
  const result = await sign(visitId);
  observations[`explicitIndependentWork${tooth}`] = { patientId: f.patientId, toothCode: tooth, sameService: f.zirconId, originalCaseId: f.caseId, independentCaseId: createdCase.case.id, originalItemId: f.itemId, independentItemId: newItem.id, saveStatus: saved.status, signStatus: result.status, duesMinor: result.body.duesMinor, after: await money(f) };
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.body.duesMinor).toBe(800000);
  expect(result.body.sessionsCompleted).toBe(1);
  expect(await immutableHistory(f)).toEqual(f.immutableBefore);
});

async function signFootprint(patientId: number, visitId: number) {
  return {
    visits: await q("SELECT to_jsonb(v) row FROM visits v WHERE id=$1", [visitId]),
    procedures: await q("SELECT to_jsonb(p) row FROM visit_procedures p WHERE visit_id=$1 ORDER BY id", [visitId]),
    invoices: await q("SELECT to_jsonb(i) row FROM invoices i WHERE patient_id=$1 ORDER BY id", [patientId]),
    payments: await q("SELECT to_jsonb(p) row FROM payments p WHERE patient_id=$1 ORDER BY id", [patientId]),
    amendments: await q("SELECT to_jsonb(a) row FROM agreement_delta_amendments a WHERE patient_id=$1 ORDER BY id", [patientId]),
    chart: await q("SELECT to_jsonb(c) row FROM tooth_conditions c WHERE visit_id=$1 ORDER BY id", [visitId]),
    sessions: await q("SELECT to_jsonb(s) row FROM treatment_sessions s WHERE visit_id=$1 ORDER BY id", [visitId]),
    labs: await q("SELECT to_jsonb(l) row FROM lab_orders l WHERE visit_id=$1 ORDER BY id", [visitId]),
    stock: await q("SELECT to_jsonb(m) row FROM inventory_movements m WHERE visit_id=$1 ORDER BY id", [visitId]),
    audit: await q("SELECT to_jsonb(a) row FROM audit_log a ORDER BY id"),
  };
}

it("does not apply another patient's amended identity to legitimate same-service work", async () => {
  const f = await fixture();
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic unrelated patient') RETURNING id", [`UNRELATED-${++serial}`]);
  const unrelated = { ...f, patientId: patient.id as number };
  const visitId = await visit(unrelated, null);
  const saved = await save(unrelated, visitId, null);
  expect(saved.status).toBe(200);
  expect(saved.body.amendedServiceConflict).toBe(false);
  const result = await sign(visitId);
  expect(result.status).toBe(200);
  expect(result.body.duesMinor).toBe(800000);
  expect(await money(f)).toEqual(f.afterAmendment);
  expect(await immutableHistory(f)).toEqual(f.immutableBefore);
});

it("keeps empty visits and price-only amendments out of the unsupported-service gate", async () => {
  const f = await fixture("original");
  const visitId = await visit(f);
  const empty = await clinicalRoute.GET(new Request("http://localhost"), context(visitId));
  expect(empty.status).toBe(200);
  expect((await empty.json()).amendedServiceConflict).toBe(false);
  const unlinked = await save(f, visitId, null, 36, f.metalId);
  expect(unlinked.status).toBe(200);
  expect(unlinked.body.amendedServiceConflict).toBe(false);
  expect(unlinked.body.planWarning).toContain("له سجل مالي قائم");
  expect(unlinked.body.planWarning).not.toContain("غير مدعوم");
  const linked = await save(f, visitId, f.itemId, 36, f.metalId);
  expect(linked.status).toBe(200);
  expect(linked.body.amendedServiceConflict).toBe(false);
  const result = await sign(visitId);
  expect(result.status).toBe(200);
  expect(result.body.duesMinor).toBe(0);
  expect(await money(f)).toEqual(f.afterAmendment);
});

it("does not treat an unrelated case label as proof that same-tooth unlinked work is new", async () => {
  const f = await fixture();
  const createdCase = await db.createClinicalCase({ patientId: f.patientId, specialty: "prosthodontics", title: "Synthetic ambiguous second case", site: "36", problem: null, responsiblePartyId: f.doctorId, orthoCaseId: null, actor: session.username });
  if (!createdCase.ok) throw Error(createdCase.reason);
  const visitId = await visit(f, createdCase.case.id);
  expect((await save(f, visitId, null)).status).toBe(200);
  const before = await signFootprint(f.patientId, visitId);
  expect((await sign(visitId)).status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
  expect(await money(f)).toEqual(f.afterAmendment);
});

it("uses the immutable amendment label after a catalog rename and preserves every prior alias", async () => {
  const f = await fixture();
  await q("UPDATE services SET name='Synthetic renamed live catalog' WHERE id=$1", [f.zirconId]);
  const [third] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic later ceramic',900000,TRUE,TRUE,'crown') RETURNING id");
  const view = await (await amendmentRoute.GET(new Request("http://localhost"), context(f.planId))).json();
  const amended = await amendmentRoute.POST(post("/amend", { idempotencyKey: `boundary-later-${++serial}`, expectedSourceHash: view.sourceHash, newServiceId: third.id, newUnitMinor: 900000, reason: "Synthetic later documented upgrade" }), context(f.planId));
  expect(amended.status).toBe(201);
  const visitId = await visit(f);
  const saved = await save(f, visitId, null);
  expect(saved.status).toBe(200);
  expect(saved.body.planWarning).toContain("فرق ترقية العلاج — Synthetic zirconia crown");
  expect(saved.body.planWarning).not.toContain("Synthetic renamed live catalog");
  const before = await signFootprint(f.patientId, visitId);
  expect((await sign(visitId)).status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
  expect(await money(f)).toMatchObject({ invoiceCount: 3, invoiceTotal: 900000, paymentCount: 1, paymentTotal: 180000, amendmentCount: 2, amendmentTotal: 400000, dueMinor: 720000 });
});

it("preserves the existing source-cancellation fence and does not reopen amended work for billing", async () => {
  const f = await fixture();
  await expect(db.setInvoiceStatus(f.invoiceId, "cancelled", { actor: session.username, actorRole: "admin" })).rejects.toThrow("approved agreement source requires financial review");
  await expect(db.setInvoiceStatus(f.amendment.deltaInvoiceId, "cancelled", { actor: session.username, actorRole: "admin" })).rejects.toThrow("agreement delta receivable is immutable");
  const visitId = await visit(f);
  expect((await save(f, visitId, null)).status).toBe(200);
  const before = await signFootprint(f.patientId, visitId);
  const financialBefore = await money(f);
  expect((await sign(visitId)).status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
  expect(await money(f)).toEqual(financialBefore);
});

it("preserves plan-ownership fences and fails closed when historical case ownership is unknown", async () => {
  const f = await fixture();
  const [other] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic drift target') RETURNING id", [`DRIFT-${++serial}`]);
  await expect(q("UPDATE treatment_plans SET patient_id=$2 WHERE id=$1", [f.planId, other.id])).rejects.toThrow("approved agreement requires financial review");
  // Mutable case corruption only in this private fixture. Do not disable any
  // fence: if a fence forbids a change, that is itself required protection.
  await q("UPDATE clinical_cases SET patient_id=$2 WHERE id=$1", [f.caseId, other.id]);
  const visitId = await visit(f);
  const saved = await save(f, visitId, null);
  expect(saved.status).toBe(200);
  expect(saved.body.planWarning).toContain("فرق ترقية العلاج — Synthetic zirconia crown");
  const before = await signFootprint(f.patientId, visitId);
  expect((await sign(visitId)).status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
});

it("fails closed when an amended item's tooth drifts away from its recorded case scope", async () => {
  const f = await fixture();
  await q("UPDATE plan_items SET tooth_code=46 WHERE id=$1", [f.itemId]);
  const visitId = await visit(f);
  expect((await save(f, visitId, null, 36)).status).toBe(200);
  const before = await signFootprint(f.patientId, visitId);
  expect((await sign(visitId)).status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
});

it.each(["coordinated", "no_case"] as const)("retains unknown coverage after %s source-scope drift", async (drift) => {
  const f = await fixture("new", drift === "no_case");
  await q("UPDATE plan_items SET tooth_code=46 WHERE id=$1", [f.itemId]);
  if (drift === "coordinated") await q("UPDATE clinical_cases SET site='46' WHERE id=$1", [f.caseId]);
  else expect((await q("SELECT case_id FROM agreement_delta_amendments WHERE plan_id=$1", [f.planId]))[0].case_id).toBeNull();
  const visitId = await visit(f);
  const saved = await save(f, visitId, null, 36);
  expect(saved.status).toBe(200);
  expect(saved.body.amendedServiceConflict).toBe(true);
  const before = await signFootprint(f.patientId, visitId);
  expect((await sign(visitId)).status).toBe(409);
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
  expect(await money(f)).toEqual(f.afterAmendment);
});

it("rechecks an amendment committed while signing waits for the existing patient lock", async () => {
  const f = await fixture();
  const [third] = await q("INSERT INTO services(name,price_minor,is_active,price_configured,category) VALUES('Synthetic concurrent ceramic',800000,TRUE,TRUE,'crown') RETURNING id");
  const visitId = await visit(f);
  const saved = await save(f, visitId, null, 36, third.id);
  expect(saved.status).toBe(200);
  expect(saved.body.planWarning).toBeNull();
  const savedVisit = await q("SELECT to_jsonb(v) row FROM visits v WHERE id=$1", [visitId]);
  const savedProcedures = await q("SELECT to_jsonb(p) row FROM visit_procedures p WHERE visit_id=$1 ORDER BY id", [visitId]);
  const view = await (await amendmentRoute.GET(new Request("http://localhost"), context(f.planId))).json();
  // Independent observer/lock-holder avoids consuming the application's small
  // connection pool while both real writers wait on the patient lock.
  const blocker = new Client({ connectionString: process.env.DATABASE_URL, ssl: false });
  await blocker.connect();
  let amendment: Promise<Response> | undefined;
  let signing: ReturnType<typeof sign> | undefined;
  try {
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM patients WHERE id=$1 FOR NO KEY UPDATE", [f.patientId]);
    const blocked = async () => {
      await blocker.query("SELECT pg_stat_clear_snapshot()");
      return Number((await blocker.query("SELECT count(*)::int n FROM pg_stat_activity WHERE datname=current_database() AND cardinality(pg_blocking_pids(pid))>0")).rows[0].n);
    };
    amendment = amendmentRoute.POST(post("/amend", { idempotencyKey: `boundary-concurrent-${++serial}`, expectedSourceHash: view.sourceHash, newServiceId: third.id, newUnitMinor: 900000, reason: "Synthetic upgrade committed before signing" }), context(f.planId));
    await expect.poll(blocked, { timeout: 5000 }).toBe(1);
    signing = sign(visitId);
    await expect.poll(blocked, { timeout: 5000 }).toBe(2);
    await blocker.query("COMMIT");
    expect((await amendment).status).toBe(201);
    const result = await signing;
    expect(result.status).toBe(409);
    expect(result.body.message).toContain("ربط الخدمة المعدلة سريريًا غير مدعوم حاليًا");
  } finally {
    observations.concurrentWaiters = (await blocker.query("SELECT state,wait_event_type,wait_event,cardinality(pg_blocking_pids(pid)) AS blockers,left(query,180) AS query FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() ORDER BY pid")).rows;
    await blocker.query("ROLLBACK");
    await blocker.end();
    await Promise.allSettled([amendment, signing].filter(Boolean));
  }
  expect(await q("SELECT to_jsonb(v) row FROM visits v WHERE id=$1", [visitId])).toEqual(savedVisit);
  expect(await q("SELECT to_jsonb(p) row FROM visit_procedures p WHERE visit_id=$1 ORDER BY id", [visitId])).toEqual(savedProcedures);
  expect(await money(f)).toMatchObject({ invoiceCount: 3, invoiceTotal: 900000, paymentCount: 1, paymentTotal: 180000, amendmentCount: 2, amendmentTotal: 400000, dueMinor: 720000 });
  expect(await immutableHistory(f)).toEqual(f.immutableBefore);
  expect(await q("SELECT id FROM audit_log WHERE action='visit.sign' AND entity_id=$1", [String(visitId)])).toHaveLength(0);
});


it("fails closed when registered amendment history is physically unavailable", async () => {
  const f = await fixture();
  const visitId = await visit(f);
  expect((await save(f, visitId, null)).body.amendedServiceConflict).toBe(true);
  expect(await q("SELECT version FROM schema_migrations WHERE version='0066'")).toHaveLength(1);
  const before = await signFootprint(f.patientId, visitId);
  // Non-destructive private-schema fault injection. Keep all event rows/fences,
  // and restore the same relation in finally; do not drop or disable history.
  await q("ALTER TABLE agreement_delta_amendments RENAME TO boundary_unavailable_amendments");
  try {
    const unavailable = await clinicalRoute.GET(new Request("http://localhost"), context(visitId));
    expect(unavailable.status).toBe(500);
    expect(await unavailable.json()).not.toHaveProperty("amendedServiceConflict");
    expect((await sign(visitId)).status).toBe(500);
  } finally {
    await q("ALTER TABLE boundary_unavailable_amendments RENAME TO agreement_delta_amendments");
  }
  expect(await signFootprint(f.patientId, visitId)).toEqual(before);
  expect(await money(f)).toEqual(f.afterAmendment);
  const restored = await clinicalRoute.GET(new Request("http://localhost"), context(visitId));
  expect(restored.status).toBe(200);
  expect((await restored.json()).amendedServiceConflict).toBe(true);
});
