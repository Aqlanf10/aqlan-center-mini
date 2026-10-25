import { createHash } from "node:crypto";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, dropPublicSchema, stubPostgresEnv } from "./_setup";
import { validatePostgresTestTarget } from "./_safe-target";
import { DEFAULT_SPECIALTY_TEMPLATES } from "../../lib/specialty-templates";
import { parseLegacyTreatmentRequest } from "../../lib/legacy-treatment";

const originalEnvironment = { ...process.env };
assertRealPostgresUrl();
const target = validatePostgresTestTarget(originalEnvironment, { allowDatabaseUrlFallback: true });
stubPostgresEnv();
const db = await import("../../lib/db");
const { createLinkedInvoice } = await import("../../lib/invoice-linkage-db");
const { createLegacyTreatment } = await import("../../lib/legacy-treatment-db");
const q = async <T = Record<string, unknown>>(sql: string, values: unknown[] = []): Promise<T[]> =>
  (await db.getPool().query<T>(sql, values)).rows;
const today = "2026-10-24";
const blockerRead = (sql: unknown) => String(sql).includes("SELECT r.id, r.blocks_case_id, c.title AS case_title, r.to_specialty, r.teeth, r.to_name");
const caseRead = (sql: unknown) => String(sql).includes("SELECT * FROM (") && String(sql).includes("'specialty' AS kind");
let fromDoctor: number;
let toDoctor: number;
let rctService: number;
let orthoService: number;
let serial = 0;
let fixtures: Awaited<ReturnType<typeof fixture>>[];

async function fixture(populated: boolean) {
  const patientId = (await q<{ id: number }>(
    "INSERT INTO patients(patient_number, full_name) VALUES($1, $1) RETURNING id", [`SYN-WORKFLOW-${++serial}`]))[0].id;
  if (!populated) return { patientId, caseId: null, referralIds: [] as number[], labels: [] as string[] };
  const invoice = await createLinkedInvoice({
    patientId, baseCurrency: "YER", discountMinor: 0, note: null, createdBy: "synthetic-admin", actorRole: "admin",
    items: [{ serviceId: rctService, category: "rct", doctorId: toDoctor, description: "Synthetic RCT", quantity: 1,
      unitPriceMinor: 50000, toothCode: 21, caseId: null, scope: null, sessions: null }],
    templates: DEFAULT_SPECIALTY_TEMPLATES, idempotencyKey: null, requestHash: null, auditDetails: {},
  });
  if (!invoice.ok) throw new Error(invoice.reason);
  const caseId = invoice.links[0].caseId!;
  const request = parseLegacyTreatmentRequest({ serviceId: orthoService, scope: "both", currency: "YER",
    agreedAmount: "300000", previouslyPaidAmount: "120000", historicalAsOf: "2026-09-30" }, today);
  if (!request.ok) throw new Error(request.message);
  const legacy = await createLegacyTreatment({ patientId, request: request.value, actor: "synthetic-admin",
    actorRole: "admin", canEditOpening: true, templates: DEFAULT_SPECIALTY_TEMPLATES });
  if (!legacy.ok) throw new Error(legacy.reason);
  const referralIds: number[] = [];
  const labels: string[] = [];
  for (const teeth of ["21", "22"]) {
    const referral = await db.createInternalReferral({ patientId, doctorPartyId: fromDoctor, toPartyId: toDoctor,
      toSpecialty: "endodontics", reason: "Synthetic referral before restoration", teeth, urgency: "soon",
      caseId: null, blocksCaseId: caseId, planItemId: null, requestedServiceId: rctService,
      actor: "synthetic-doctor", actorRole: "doctor" });
    if (!referral.ok) throw new Error(referral.reason);
    referralIds.push(referral.referral.id);
    labels.push(`علاج الجذور (العصب) — الأسنان ${teeth} (إحالة #${referral.referral.id} إلى Synthetic recipient)`);
  }
  return { patientId, caseId, referralIds, labels };
}

beforeAll(async () => {
  await dropPublicSchema(target.testUrl.toString());
  await db.ensureSchema();
  fromDoctor = (await q<{ id: number }>("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic referrer') RETURNING id"))[0].id;
  toDoctor = (await q<{ id: number }>("INSERT INTO parties(kind,name) VALUES('doctor','Synthetic recipient') RETURNING id"))[0].id;
  rctService = (await q<{ id: number }>("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic RCT','rct',50000,TRUE,TRUE) RETURNING id"))[0].id;
  orthoService = (await q<{ id: number }>("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('Synthetic ortho','ortho',300000,TRUE,TRUE) RETURNING id"))[0].id;
  fixtures = [await fixture(true), await fixture(true), await fixture(false)];
}, 180000);
afterAll(async () => { vi.restoreAllMocks(); await db.resetPoolForTesting(); });

function projections(cases: Awaited<ReturnType<typeof db.listPatientCases>>) {
  return {
    assessmentCases: cases.filter(one => one.kind === "specialty" && one.needsAssessment === true && one.id !== null && one.orthoCaseId === null && one.legacy !== true)
      .map(one => ({ id: one.id, patientId: one.patientId, kind: "specialty", orthoCaseId: null,
        specialty: one.specialty, title: one.title, needsAssessment: true })),
    legacyCases: cases.filter(one => one.legacy === true && (one.status === "active" || one.status === "waiting"))
      .map(one => ({ id: one.id, patientId: one.patientId, kind: one.kind, orthoCaseId: one.orthoCaseId,
        specialty: one.specialty, title: one.title, site: one.site ?? null, status: one.status, legacy: true })),
  };
}

async function countedWorkflow(patientId: number) {
  // Observe actual PostgreSQL executions, including acquired-client queries, not
  // a mocked return value or an exported wrapper call count.
  const query = vi.spyOn(Client.prototype, "query");
  const started = performance.now();
  try {
    const summary = await db.patientWorkflow(patientId, today);
    const calls = query.mock.calls;
    return { summary, totalReads: calls.length, blockerReads: calls.filter(args => blockerRead(args[0])),
      caseReads: calls.filter(args => caseRead(args[0])), elapsedMs: performance.now() - started };
  } finally { query.mockRestore(); }
}

describe("patient workflow only reads referral blockers for its alerts", () => {
  it.each([0, 1, 2])("keeps patient %i projections and alerts with one blocker SQL execution", async index => {
    const f = fixtures[index];
    const cases = await db.listPatientCases(f.patientId);
    const read = await countedWorkflow(f.patientId);
    expect(read.summary.assessmentCases).toEqual(projections(cases).assessmentCases);
    expect(read.summary.legacyCases).toEqual(projections(cases).legacyCases);
    const blockedCase = cases.find(one => one.id === f.caseId);
    expect(blockedCase?.waitingOn ?? []).toEqual(f.labels);
    expect(read.summary.alerts.filter(alert => alert.kind === "referral_blocker")).toEqual(f.caseId === null ? [] : [{
      kind: "referral_blocker", severity: "warning", text: `حالة «${blockedCase!.title}» بانتظار: ${f.labels.join("، ")}`,
    }]);
    expect(read.summary.assessmentCases).toHaveLength(index === 2 ? 0 : 1);
    expect(read.summary.legacyCases).toHaveLength(index === 2 ? 0 : 1);
    if (index !== 2) expect(read.summary.financial?.byCurrency).toMatchObject({
      YER: { balanceMinor: 230000, invoicedMinor: 50000, openingMinor: 180000 },
    });
    console.info("SYNTHETIC_WORKFLOW_READ_WITNESS", JSON.stringify({ patientIndex: index,
      totalQueries: read.totalReads, blockerQueries: read.blockerReads.length, elapsedMs: read.elapsedMs,
      projectionHash: createHash("sha256").update(JSON.stringify({ ...projections(cases), alerts: read.summary.alerts,
        financial: read.summary.financial })).digest("hex") }));
    expect(read.caseReads).toHaveLength(1);
    expect(read.blockerReads).toHaveLength(1);
    expect(read.blockerReads[0][1]).toEqual([f.patientId]);
  });

  it("keeps the existing missing-patient result with one case and one blocker read", async () => {
    const read = await countedWorkflow(2147483647);
    expect(read.summary.patient).toBeNull();
    expect(read.summary.assessmentCases).toEqual([]);
    expect(read.summary.legacyCases).toEqual([]);
    expect(read.summary.alerts).toEqual([]);
    expect(read.caseReads).toHaveLength(1);
    expect(read.blockerReads).toHaveLength(1);
  });

  it("retains fresh waitingOn on public callers and does not share results across patients or requests", async () => {
    const [first, second] = fixtures;
    const before = await db.patientWorkflow(first.patientId, today);
    expect(await db.transitionInternalReferral({ id: first.referralIds[0], action: "cancel", note: "Synthetic cancellation",
      appointmentId: null, procedurePerformed: null, followupRequired: null, mayReturn: null,
      actor: "synthetic-doctor", actorRole: "doctor" })).toMatchObject({ ok: true });
    const after = await countedWorkflow(first.patientId);
    expect(after.summary.alerts.filter(alert => alert.kind === "referral_blocker")).not.toEqual(
      before.alerts.filter(alert => alert.kind === "referral_blocker"));
    expect((await db.listPatientCases(first.patientId)).find(one => one.id === first.caseId)?.waitingOn).toEqual(first.labels.slice(1));
    const secondRead = await countedWorkflow(second.patientId);
    expect((await db.listPatientCases(second.patientId)).find(one => one.id === second.caseId)?.waitingOn).toEqual(second.labels);
    expect(secondRead.summary.alerts.filter(alert => alert.kind === "referral_blocker")[0].text).toContain(second.labels.join("، "));
    expect(after.blockerReads).toHaveLength(1);
    expect(secondRead.blockerReads).toHaveLength(1);
  });

  it("keeps the case read at its original point rather than reusing an earlier snapshot", async () => {
    const f = fixtures[1];
    const before = await db.patientWorkflow(f.patientId, today);
    const pool = db.getPool();
    const original = pool.query.bind(pool);
    let changed = false;
    const query = vi.spyOn(pool, "query").mockImplementation(async (sql, values) => {
      const result = await original(sql, values);
      if (!changed && blockerRead(sql)) {
        changed = true;
        await original("UPDATE clinical_cases SET title = $1 WHERE id = $2", ["Synthetic updated assessment", f.caseId]);
      }
      return result;
    });
    try {
      const during = await db.patientWorkflow(f.patientId, today);
      expect(changed).toBe(true);
      expect(during.assessmentCases[0].title).toBe("Synthetic updated assessment");
      expect(during.alerts.filter(alert => alert.kind === "referral_blocker")).toEqual(
        before.alerts.filter(alert => alert.kind === "referral_blocker"));
    } finally { query.mockRestore(); }
    expect((await db.patientWorkflow(f.patientId, today)).alerts.filter(alert => alert.kind === "referral_blocker")[0].text)
      .toContain("Synthetic updated assessment");
  });

  it.each(["blockers", "cases"] as const)("propagates a failed %s read and recovers on the next request", async failing => {
    const f = fixtures[1];
    const marker = new Error(`Synthetic workflow ${failing} read failure`);
    const pool = db.getPool();
    const original = pool.query.bind(pool);
    let failures = 0;
    const query = vi.spyOn(pool, "query").mockImplementation(async (sql, values) => {
      if ((failing === "blockers" ? blockerRead(sql) : caseRead(sql))) { failures++; throw marker; }
      return original(sql, values);
    });
    try {
      await expect(db.patientWorkflow(f.patientId, today)).rejects.toBe(marker);
      expect(failures).toBe(1);
      failures = 0;
      await expect(db.listPatientCases(f.patientId)).rejects.toBe(marker);
      expect(failures).toBe(1);
    } finally { query.mockRestore(); }
    const recovered = await countedWorkflow(f.patientId);
    expect(recovered.summary).toMatchObject(projections(await db.listPatientCases(f.patientId)));
    expect(recovered.blockerReads).toHaveLength(1);
  });
});
