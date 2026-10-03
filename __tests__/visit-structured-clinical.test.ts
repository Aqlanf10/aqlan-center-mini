import { beforeEach, describe, expect, it, vi } from "vitest";
import { readStructuredClinical } from "../lib/visit-structured-clinical";

const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), ensure: vi.fn() }));
vi.mock("../lib/db", () => ({ ensureSchema: db.ensure, getPool: () => ({ connect: async () => db }) }));
import { getVisitStructuredClinical } from "../lib/visit-structured-clinical-db";

// Fixed already-linked synthetic patient/visit. No real database or network.
const visitId = 91001; const patientId = 92001;
const recordedAt = new Date("2026-10-03T09:00:00Z");
const base = { id: 1, visitId, patientId, caseId: 11, doctorId: 94001, doctorName: "Recorded clinician",
  recordedAt, updatedAt: null };
const endo = { ...base, treatmentId: 12, toothCode: 16, version: 3, stage: "shaping",
  canalCount: 2, measuredCanalCount: 1, obturatedCanalCount: 0 };
const perio = { ...base, id: 2, caseId: null, revision: 4, siteCount: 3, toothCount: 1,
  recordedDepthSites: 1, recordedBleedingSites: 2 };
beforeEach(() => {
  vi.clearAllMocks();
  db.query.mockImplementation(async (sql: string) => {
    if (sql.includes("SELECT signed_at")) return { rows: [{ signed_at: null, signed_by: null, case_id: null, case_context_valid: true, endo_count: 1, perio_count: 1 }] };
    if (sql.includes("FROM endo_visits")) return { rows: [endo] };
    if (sql.includes("FROM perio_exams")) return { rows: [perio] };
    return { rows: [] };
  });
});

describe("exact-visit structured clinical read projection", () => {
  it("reads one snapshot with original providers, record refs and coverage only", async () => {
    const projection = await getVisitStructuredClinical(visitId, patientId);
    expect(projection).toMatchObject({ status: "ready", visitId, patientId, visitCaseId: null, signedAt: null,
      endodontics: [{ id: 1, treatmentId: 12, toothCode: 16, doctorId: 94001, version: 3, measuredCanalCount: 1 }],
      periodontics: [{ id: 2, revision: 4, recordedDepthSites: 1, recordedBleedingSites: 2 }] });
    expect(db.query.mock.calls[0][0]).toBe("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
    for (const [sql, values] of db.query.mock.calls.filter(([sql]) => sql.trimStart().startsWith("SELECT"))) {
      expect(values).toEqual([visitId, patientId]);
      expect(sql).toMatch(/patient_id = \$2/);
      expect(sql).not.toMatch(/plan_items|invoices|visit_procedures|note|chief_complaint/);
    }
    expect(db.query.mock.calls.find(([sql]) => sql.includes("FROM endo_visits ev"))?.[0])
      .toContain("t.patient_id = v.patient_id");
    expect(db.query.mock.calls.find(([sql]) => sql.includes("FROM perio_exams e"))?.[0])
      .toContain("e.case_id IS NULL OR c.id IS NOT NULL");
    expect(db.release).toHaveBeenCalledOnce();
  });
  it("takes specialty signature from the canonical visit in the same snapshot", async () => {
    db.query.mockImplementation(async (sql: string) => sql.includes("SELECT signed_at")
      ? { rows: [{ signed_at: recordedAt, signed_by: "Canonical signer", case_id: null, case_context_valid: true, endo_count: 1, perio_count: 1 }] }
      : { rows: sql.includes("FROM endo_visits") ? [endo] : sql.includes("FROM perio_exams") ? [perio] : [] });
    expect(await getVisitStructuredClinical(visitId, patientId)).toMatchObject({
      signedAt: recordedAt.toISOString(), signedBy: "Canonical signer",
      endodontics: [{ doctorName: "Recorded clinician" }],
    });
  });
  it("preserves the actual canonical visit case, including an explicitly unlinked case", async () => {
    expect(await getVisitStructuredClinical(visitId, patientId)).toMatchObject({ status: "ready", visitCaseId: null });
    db.query.mockImplementation(async (sql: string) => sql.includes("SELECT signed_at")
      ? { rows: [{ signed_at: null, signed_by: null, case_id: 11, case_context_valid: true, endo_count: 1, perio_count: 1 }] }
      : { rows: sql.includes("FROM endo_visits") ? [endo] : sql.includes("FROM perio_exams") ? [{ ...perio, caseId: 11 }] : [] });
    expect(await getVisitStructuredClinical(visitId, patientId)).toMatchObject({ status: "ready", visitCaseId: 11 });
  });
  it("recognizes successful empty reads without treating failures as empty", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT signed_at") ? [{ signed_at: null, signed_by: null, case_id: null, case_context_valid: true, endo_count: 0, perio_count: 0 }] : [] }));
    expect(await getVisitStructuredClinical(visitId, patientId)).toMatchObject({ status: "ready", endodontics: [], periodontics: [] });
    db.query.mockRejectedValueOnce(new Error("synthetic unavailable"));
    await expect(getVisitStructuredClinical(visitId, patientId)).rejects.toThrow("synthetic unavailable");
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
  });
  it("awaits rollback before release if an authorized linked visit disappears", async () => {
    const order: string[] = [];
    db.query.mockImplementation(async (sql: string) => { order.push(sql); return { rows: [] }; });
    db.release.mockImplementation(() => order.push("release"));
    await expect(getVisitStructuredClinical(visitId, patientId)).rejects.toThrow("no longer");
    expect(order.slice(-2)).toEqual(["ROLLBACK", "release"]);
    expect(order.join(" ")).not.toContain("FROM endo_visits ev");
  });
  it.each(["endo", "perio"])("fails closed when an existing %s record is excluded by its patient/case fences", async (specialty) => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes("SELECT signed_at")) return { rows: [{ signed_at: null, signed_by: null, case_id: null, case_context_valid: true, endo_count: 1, perio_count: 1 }] };
      if (sql.includes("FROM endo_visits ev")) return { rows: specialty === "endo" ? [] : [endo] };
      if (sql.includes("FROM perio_exams e")) return { rows: specialty === "perio" ? [] : [perio] };
      return { rows: [] };
    });
    expect(await getVisitStructuredClinical(visitId, patientId)).toEqual({ status: "unavailable", visitId, patientId });
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("does not expose a canonical visit case reference with unverifiable patient ownership", async () => {
    db.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("SELECT signed_at")
      ? [{ signed_at: null, signed_by: null, case_id: 99, case_context_valid: false, endo_count: 1, perio_count: 1 }] : [] }));
    expect(await getVisitStructuredClinical(visitId, patientId)).toEqual({ status: "unavailable", visitId, patientId });
    expect(db.query.mock.calls).toHaveLength(3);
    expect(db.query.mock.calls.at(-1)?.[0]).toBe("COMMIT");
  });
  it("allowlists source rows and wire payloads, excluding narrative, plan and finance fields", async () => {
    const projection = await getVisitStructuredClinical(visitId, patientId);
    if (projection.status !== "ready") throw new Error("Expected synthetic ready projection");
    const excess = { ...projection, invoiceId: 99, note: "not part of projection",
      endodontics: projection.endodontics.map((row) => ({ ...row, crownPlanItemId: 89, note: "not copied" })) };
    expect(readStructuredClinical(excess, visitId, patientId)).toEqual(projection);
  });
  it("counts explicit zero depth and false bleeding as recorded, not as missing", async () => {
    await getVisitStructuredClinical(visitId, patientId);
    const sql = db.query.mock.calls.find(([sql]) => sql.includes("FROM perio_exams e"))?.[0];
    expect(sql).toContain("WHERE probing_depth_mm IS NOT NULL");
    expect(sql).toContain("WHERE bleeding_on_probing IS NOT NULL");
    expect(sql).not.toContain("bleeding_on_probing IS TRUE");
  });
  it("rejects missing, malformed or different-context wire summaries", async () => {
    const ready = await getVisitStructuredClinical(visitId, patientId);
    expect(readStructuredClinical(ready, visitId, patientId)).toEqual(ready);
    for (const value of [null, {}, { ...ready, patientId: 92002 }, { ...ready, visitId: 91002 },
      { ...ready, status: "unavailable" }, { ...ready, periodontics: null },
      { ...ready, visitCaseId: undefined }, { ...ready, visitCaseId: "11" }, { ...ready, visitCaseId: 11 },
      { ...ready, endodontics: [{ ...endo, recordedAt: recordedAt.toISOString(), patientId: 92002 }] },
      { ...ready, endodontics: [{ ...endo, recordedAt: recordedAt.toISOString(), measuredCanalCount: 99 }] },
    ]) expect(readStructuredClinical(value, visitId, patientId)).toEqual({ status: "unavailable", visitId, patientId });
  });
});
