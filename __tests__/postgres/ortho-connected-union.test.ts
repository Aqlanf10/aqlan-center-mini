import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createSessionToken, hashPassword, sessionCredentialVersion, SESSION_COOKIE, type SessionPayload } from "../../lib/auth";
import { openPeriodontalFixture } from "./_periodontal-fixture";
import { CASE_TEMPLATE_VERSION } from "../../lib/ortho-case-template";
import { STUDY_TEMPLATE_HASH } from "../../lib/ortho-case-study-template";
import type { OpenAssessmentCommand, ActivateAssessmentCommand } from "../../lib/ortho-assessment-lifecycle";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { invoiceRequestFingerprint } from "../../lib/invoice-clinical-linkage";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";

// Only cookie transport is substituted. All authority, row locks, clinical and
// finance tables, audit and rollback use a fresh owned PostgreSQL 18 database.
const transport = vi.hoisted(() => ({ token: "" }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: (name: string) => name === SESSION_COOKIE ? { value: transport.token } : undefined }), headers: async () => ({ get: () => null }) }));
let fixture: Awaited<ReturnType<typeof openPeriodontalFixture>>;
let lifecycle: typeof import("../../lib/ortho-assessment-lifecycle-store");
let study: typeof import("../../lib/ortho-case-study-store");
let session: SessionPayload, patientId: number, actorId: number, username: string, passwordHash: string;
let linkage: typeof import("../../lib/invoice-linkage-db"), doctorId: number;
let legacy: typeof import("../../lib/legacy-treatment-db");
const key = () => `synthetic_${randomUUID().replaceAll("-", "")}`;
const open = (): OpenAssessmentCommand => ({ schemaVersion: 1, kind: "open_assessment", commandId: key(), patientId, bridge: { mode: "new" }, intakeKind: "new", reason: "Synthetic connected intake" });
const financialCounts = async () => (await fixture.pool.query(`SELECT
 (SELECT count(*)::int FROM invoices) invoices, (SELECT count(*)::int FROM payments) payments,
 (SELECT count(*)::int FROM treatment_plans) plans, (SELECT count(*)::int FROM plan_installments) installments`)).rows[0];
async function opened(command = open()) {
  const result = await lifecycle.recordOrthoLifecycle({ patientId, session, command });
  expect(result.ok).toBe(true); if (!result.ok) throw new Error(result.code);
  return result.event;
}
async function billingRequest(caseId: number | null, existingPlanId: number | null = null, scope = "both") {
  const serviceId = (await fixture.pool.query("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES($1,'ortho',10000,true,true) RETURNING id", [key()])).rows[0].id;
  const items = [{ serviceId, category: "ortho", doctorId, description: "Synthetic separately authorized orthodontic service", quantity: 1, unitPriceMinor: 10000, toothCode: null, scope, caseId, sessions: 1 }];
  return { patientId, existingPlanId, baseCurrency: "YER" as const, discountMinor: 0, note: null, createdBy: username, actorRole: "admin", templates: DEFAULT_SPECIALTY_TEMPLATES, items,
    idempotencyKey: key(), requestHash: invoiceRequestFingerprint({ patientId, existingPlanId, currency: "YER", discountMinor: 0, items }), auditDetails: {} };
}
async function historicalRequest(caseId: number | null) {
  const serviceId = (await billingRequest(null)).items[0].serviceId;
  const parsed = parseLegacyTreatmentRequest({ serviceId, scope: "both", caseId, currency: "YER", agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30", idempotencyKey: key() }, "2026-10-11");
  if (!parsed.ok) throw new Error(parsed.message);
  return { patientId, request: parsed.value, actor: username, actorRole: "admin", canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES };
}
async function activate(event: Awaited<ReturnType<typeof opened>>) {
  const command: ActivateAssessmentCommand = { schemaVersion: 1, kind: "activate_assessment", commandId: key(), patientId, orthoCaseId: event.orthoCaseId, clinicalCaseId: event.clinicalCaseId, expectedLifecycleVersion: 1, reason: "Explicit synthetic treatment decision",
    treatment: { appliance: "fixed_metal", arches: "both", slot: null, bracketSystem: null, phase: "working", start: { state: "unknown", reason: "No source date" }, plannedMonths: null }, financialPlan: null };
  expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: false });
}
beforeAll(async () => {
  vi.stubEnv("SESSION_SECRET", "synthetic-connected-union-only-2026");
  fixture = await openPeriodontalFixture(process.env, { pristine: true });
  await fixture.db.ensureSchema(); // composed bootstrap, no test-only ortho SQL
  username = key(); passwordHash = await hashPassword(key());
  actorId = (await fixture.pool.query("INSERT INTO users(username,display_name,password_hash,role,is_active) VALUES($1,'Synthetic union actor',$2,'admin',true) RETURNING id", [username, passwordHash])).rows[0].id;
  lifecycle = await import("../../lib/ortho-assessment-lifecycle-store");
  study = await import("../../lib/ortho-case-study-store");
  linkage = await import("../../lib/invoice-linkage-db");
  legacy = await import("../../lib/legacy-treatment-db");
  doctorId = (await fixture.pool.query("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic union billing doctor') RETURNING id")).rows[0].id;
  await fixture.db.openShift({ openedBy: username, opening: { YER: 0, SAR: 0, USD: 0 } });
}, 180_000);
beforeEach(async () => {
  await fixture.pool.query("UPDATE users SET is_active=true WHERE id=$1", [actorId]);
  transport.token = createSessionToken({ userId: actorId, username, role: "admin", expiresAt: Date.now() + 600_000, credentialVersion: sessionCredentialVersion(passwordHash) });
  const current = await (await import("../../lib/session")).requireSession();
  if (!current) throw new Error("Synthetic session unavailable"); session = current;
  patientId = (await fixture.pool.query("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic union patient') RETURNING id", [key()])).rows[0].id;
});
afterAll(async () => { transport.token = ""; try { await fixture?.close(); } finally { vi.unstubAllEnvs(); } });

describe("connected ortho union", () => {
  it("invoice then assessment keeps explicit and automatic subsequent billing on the same compatible bridge", async () => {
    const first = await linkage.createLinkedInvoice(await billingRequest(null));
    expect(first.ok).toBe(true); if (!first.ok) throw new Error(first.reason);
    const read = await lifecycle.readOrthoLifecycle({ patientId, session });
    expect(read.ok).toBe(true); if (!read.ok) throw new Error(read.code);
    expect(read.clinicalCases).toHaveLength(1);
    const bridge = read.clinicalCases[0];
    const event = await opened({ ...open(), bridge: { mode: "existing", clinicalCaseId: bridge.id, expectedContentHash: bridge.contentHash } });
    expect(event.clinicalCaseId).toBe(first.links[0].caseId);
    for (const choice of [bridge.id, null]) {
      const input = await billingRequest(choice, first.planId);
      expect((await linkage.previewInvoiceLinkage(input))[0]).toMatchObject({ refusal: null, case: { mode: "existing", id: bridge.id } });
      const issued = await linkage.createLinkedInvoice(input);
      expect(issued.ok).toBe(true); if (!issued.ok) throw new Error(issued.reason);
      expect(issued.links[0]).toMatchObject({ caseId: bridge.id, caseCreated: false });
      expect(await linkage.createLinkedInvoice(input)).toMatchObject({ ok: true, replayed: true });
    }
    expect((await fixture.pool.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: bridge.id }]);
    expect((await fixture.pool.query("SELECT id,status,plan_id FROM ortho_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: event.orthoCaseId, status: "assessment", plan_id: null }]);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM invoices WHERE patient_id=$1", [patientId])).rows[0].n).toBe(3);
  });
  it("assessment then invoice rejects unknown arch scope clearly and never creates a second shell or financial rows", async () => {
    const event = await opened(), before = await financialCounts();
    for (const choice of [event.clinicalCaseId, null]) {
      const input = await billingRequest(choice);
      expect((await linkage.previewInvoiceLinkage(input))[0].refusal).toBe("bad_site");
      expect(await linkage.createLinkedInvoice(input)).toMatchObject({ ok: false, reason: "bad_site" });
      expect(await financialCounts()).toEqual(before);
      expect((await fixture.pool.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: event.clinicalCaseId }]);
    }
  });
  it("a known but incompatible assessment site also blocks automatic financial shell creation", async () => {
    const first = await linkage.createLinkedInvoice(await billingRequest(null, null, "upper"));
    if (!first.ok) throw new Error(first.reason);
    const read = await lifecycle.readOrthoLifecycle({ patientId, session });
    if (!read.ok) throw new Error(read.code);
    const bridge = read.clinicalCases[0];
    await opened({ ...open(), bridge: { mode: "existing", clinicalCaseId: bridge.id, expectedContentHash: bridge.contentHash } });
    const before = await financialCounts(), invoice = await billingRequest(null, first.planId), historical = await historicalRequest(null);
    expect((await linkage.previewInvoiceLinkage(invoice))[0].refusal).toBe("bad_site");
    expect(await linkage.createLinkedInvoice(invoice)).toMatchObject({ ok: false, reason: "bad_site" });
    expect(await legacy.previewLegacyTreatment(historical)).toMatchObject({ ok: false, reason: "ortho_scope_mismatch" });
    expect(await legacy.createLegacyTreatment(historical)).toMatchObject({ ok: false, reason: "ortho_scope_mismatch" });
    expect(await financialCounts()).toEqual(before);
    expect((await fixture.pool.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: bridge.id }]);
  });
  it("concurrent intake and financial entry serialize to one episode, with an explicit non-writing refusal for the losing context", async () => {
    const input = await billingRequest(null);
    const [assessment, invoice] = await Promise.all([
      lifecycle.recordOrthoLifecycle({ patientId, session, command: open() }), linkage.createLinkedInvoice(input),
    ]);
    expect(Number(assessment.ok) + Number(invoice.ok)).toBe(1);
    if (assessment.ok) expect(invoice).toMatchObject({ ok: false, reason: "bad_site" });
    else expect(assessment).toMatchObject({ ok: false, code: "explicit_existing_case_required" });
    expect((await fixture.pool.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toHaveLength(1);
    expect((await fixture.pool.query("SELECT id FROM invoices WHERE patient_id=$1", [patientId])).rows).toHaveLength(invoice.ok ? 1 : 0);
  });
  it("cancelled assessment cannot be explicitly selected by either financial writer", async () => {
    const event = await opened();
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command: {
      schemaVersion: 1, kind: "cancel_assessment", commandId: key(), patientId, orthoCaseId: event.orthoCaseId,
      clinicalCaseId: event.clinicalCaseId, expectedLifecycleVersion: 1, reason: "Synthetic cancellation without treatment",
    } })).toMatchObject({ ok: true });
    const before = await financialCounts(), invoice = await billingRequest(event.clinicalCaseId), historical = await historicalRequest(event.clinicalCaseId);
    expect((await linkage.previewInvoiceLinkage(invoice))[0].refusal).toBe("bad_case");
    expect(await linkage.createLinkedInvoice(invoice)).toMatchObject({ ok: false, reason: "bad_case" });
    expect(await legacy.previewLegacyTreatment(historical)).toMatchObject({ ok: false, reason: "bad_case" });
    expect(await legacy.createLegacyTreatment(historical)).toMatchObject({ ok: false, reason: "bad_case" });
    expect(await financialCounts()).toEqual(before);
    expect((await fixture.pool.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: event.clinicalCaseId }]);
  });
  it.each(["invoice", "historical"] as const)("%s first retains the same bridge through assessment and 300000/120000 registration", async (origin) => {
    const initial = origin === "invoice" ? await linkage.createLinkedInvoice(await billingRequest(null)) : await legacy.createLegacyTreatment(await historicalRequest(null));
    expect(initial.ok).toBe(true); if (!initial.ok) throw new Error(initial.reason);
    const read = await lifecycle.readOrthoLifecycle({ patientId, session });
    if (!read.ok) throw new Error(read.code);
    const bridge = read.clinicalCases[0];
    const event = await opened({ ...open(), intakeKind: origin === "historical" ? "transferred" : "new", bridge: { mode: "existing", clinicalCaseId: bridge.id, expectedContentHash: bridge.contentHash } });
    for (const choice of [bridge.id, null]) {
      const input = await historicalRequest(choice), before = await financialCounts();
      const preview = await legacy.previewLegacyTreatment(input);
      expect(preview).toMatchObject({ ok: true, preview: { case: { mode: "existing", id: bridge.id } } });
      const result = await legacy.createLegacyTreatment(input);
      expect(result).toMatchObject({ ok: true, caseCreated: false, agreement: { caseId: bridge.id, agreedMinor: 300000, previouslyPaidMinor: 120000, remainingMinor: 180000 } });
      expect(await legacy.createLegacyTreatment(input)).toMatchObject({ ok: true, replayed: true });
      const after = await financialCounts();
      expect(after.invoices).toBe(before.invoices); expect(after.payments).toBe(before.payments);
    }
    const beforeActivation = await financialCounts(); await activate(event);
    expect(await financialCounts()).toEqual(beforeActivation);
    expect((await fixture.pool.query("SELECT id,ortho_case_id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: bridge.id, ortho_case_id: event.orthoCaseId }]);
    expect((await fixture.pool.query("SELECT amount_minor::int amount FROM patient_opening_balances WHERE patient_id=$1", [patientId])).rows).toEqual([{ amount: origin === "historical" ? 540000 : 360000 }]);
  });
  it("assessment with unknown arches refuses historical registration without creating debt or a second shell; explicit activation then permits the same bridge", async () => {
    const event = await opened();
    for (const choice of [event.clinicalCaseId, null]) {
      const input = await historicalRequest(choice), before = await financialCounts();
      const reason = choice === null ? "ortho_scope_mismatch" : "bad_case";
      expect(await legacy.previewLegacyTreatment(input)).toMatchObject({ ok: false, reason });
      expect(await legacy.createLegacyTreatment(input)).toMatchObject({ ok: false, reason });
      expect(await financialCounts()).toEqual(before);
      expect((await fixture.pool.query("SELECT patient_id FROM patient_opening_balances WHERE patient_id=$1", [patientId])).rows).toEqual([]);
    }
    await activate(event);
    const input = await historicalRequest(null);
    expect(await legacy.createLegacyTreatment(input)).toMatchObject({ ok: true, caseCreated: false, agreement: { caseId: event.clinicalCaseId, remainingMinor: 180000 } });
    expect(await legacy.createLegacyTreatment(input)).toMatchObject({ ok: true, replayed: true });
    expect((await fixture.pool.query("SELECT id FROM clinical_cases WHERE patient_id=$1", [patientId])).rows).toEqual([{ id: event.clinicalCaseId }]);
  });
  it("opens, saves and reloads a study before treatment; exact concurrent retries create one case and no finance", async () => {
    const before = await financialCounts(), command = open();
    const results = await Promise.all([1, 2].map(() => lifecycle.recordOrthoLifecycle({ patientId, session, command })));
    expect(results.map(result => result.ok && result.replayed).sort()).toEqual([false, true]);
    const event = await opened(command), scope = { patientId, orthoCaseId: event.orthoCaseId, session };
    const row = (await fixture.pool.query("SELECT status,start_date,appliance,phase,planned_months,plan_id FROM ortho_cases WHERE id=$1", [event.orthoCaseId])).rows[0];
    expect(row).toEqual({ status: "assessment", start_date: null, appliance: null, phase: null, planned_months: null, plan_id: null });
    const save = { schemaVersion: 1, clientRequestId: key(), expectedHead: null, baseDocumentedRevision: null, kind: "draft", documentedFrom: null, reason: "Synthetic study, no export dependency",
      content: { template: { key: "full-orthodontic-case", version: CASE_TEMPLATE_VERSION, contentHash: STUDY_TEMPLATE_HASH }, identityDisclosure: "case_only", sources: [], groups: [], panels: [], mediaUses: [], comment: "Preserved synthetic complaint" } };
    expect(await study.saveOrthoCaseStudy({ ...scope, command: save })).toMatchObject({ ok: true, replayed: false });
    expect(await study.saveOrthoCaseStudy({ ...scope, command: save })).toMatchObject({ ok: true, replayed: true });
    const read = await study.getOrthoCaseStudy(scope);
    expect(read.ok).toBe(true); if (!read.ok) throw new Error(read.code);
    expect(read.history).toHaveLength(1); expect(read.revision?.content.authored.comment).toBe(save.content.comment);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    expect((await fixture.pool.query("SELECT count(*)::int n FROM clinical_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(1);
    expect(await financialCounts()).toEqual(before);
  });
  it("records an explicitly unknown treatment start and duration without substituting episode or entry dates", async () => {
    const before = await financialCounts(), event = await opened({ ...open(), intakeKind: "transferred" });
    const command: ActivateAssessmentCommand = { schemaVersion: 1, kind: "activate_assessment", commandId: key(), patientId, orthoCaseId: event.orthoCaseId, clinicalCaseId: event.clinicalCaseId, expectedLifecycleVersion: 1, reason: "Synthetic transferred treatment evidence",
      treatment: { appliance: "fixed_metal", arches: "both", slot: null, bracketSystem: null, phase: "working", start: { state: "unknown", reason: "No historical start record supplied" }, plannedMonths: null }, financialPlan: null };
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: false });
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: true });
    const cases = await fixture.db.listPatientOrthoCases(patientId, "2026-10-11");
    expect(cases).toHaveLength(1); expect(cases[0]).toMatchObject({ status: "active", startDate: null, plannedMonths: null, phase: "working", slot: null, progress: { monthsElapsed: null, monthsRemaining: null, percent: null } });
    const read = await lifecycle.readOrthoLifecycle({ patientId, session });
    expect(read).toMatchObject({ ok: true, history: [{ kind: "assessment_opened" }, { kind: "assessment_activated" }] });
    expect(await financialCounts()).toEqual(before);
  });
  it("rechecks a revoked actor inside the transaction after the request waits for the patient lock", async () => {
    const holder = await fixture.pool.connect();
    let pending: ReturnType<typeof lifecycle.recordOrthoLifecycle> | undefined;
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() pid")).rows[0].pid;
      await holder.query("SELECT id FROM patients WHERE id=$1 FOR UPDATE", [patientId]);
      pending = lifecycle.recordOrthoLifecycle({ patientId, session, command: open() });
      await vi.waitFor(async () => {
        const blocked = await fixture.pool.query("SELECT pid FROM pg_stat_activity WHERE datname=current_database() AND $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM patients%'", [pid]);
        expect(blocked.rows.length).toBeGreaterThan(0);
      }, { timeout: 10_000, interval: 20 });
      await fixture.pool.query("UPDATE users SET is_active=false WHERE id=$1", [actorId]);
      await holder.query("COMMIT");
      expect(await pending).toMatchObject({ ok: false, status: 401 });
      expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(0);
    } finally { await holder.query("ROLLBACK"); holder.release(); await pending?.catch(() => undefined); }
  });
  it("rejects a stale actor and a cross-patient command before creating any identity", async () => {
    const command = open();
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session: { ...session, userId: actorId + 1000 }, command })).toMatchObject({ ok: false, status: 401 });
    expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command: { ...command, patientId: patientId + 1000 } })).toMatchObject({ ok: false, status: 409, code: "scope_changed" });
    expect((await fixture.pool.query("SELECT count(*)::int n FROM ortho_cases WHERE patient_id=$1", [patientId])).rows[0].n).toBe(0);
  });
  it("rolls back case, bridge and lifecycle event on audit failure, then retries the same command once", async () => {
    const command = open(), before = await financialCounts();
    await fixture.pool.query(`CREATE FUNCTION synthetic_union_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic union audit failure'; END $$;
      CREATE TRIGGER synthetic_union_audit_failure BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_union_audit_failure()`);
    try {
      await expect(lifecycle.recordOrthoLifecycle({ patientId, session, command })).rejects.toThrow("synthetic union audit failure");
      for (const table of ["ortho_cases", "clinical_cases", "ortho_case_lifecycle_events"]) expect((await fixture.pool.query(`SELECT count(*)::int n FROM ${table} WHERE patient_id=$1`, [patientId])).rows[0].n).toBe(0);
      expect(await financialCounts()).toEqual(before);
    } finally { await fixture.pool.query("DROP TRIGGER synthetic_union_audit_failure ON audit_log; DROP FUNCTION synthetic_union_audit_failure()"); }
    await opened(command); expect(await lifecycle.recordOrthoLifecycle({ patientId, session, command })).toMatchObject({ ok: true, replayed: true });
  });
});
