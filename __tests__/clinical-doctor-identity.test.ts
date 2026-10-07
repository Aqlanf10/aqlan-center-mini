import { readFileSync } from "node:fs";
import ts from "typescript";
import { describe, expect, it, vi } from "vitest";
import { ClinicalDoctorIdentityConflict, lockClinicalDoctors } from "../lib/clinical-doctor-identity";
import type { DbClient } from "../lib/db";
import { isCurrency, requireCurrency } from "../lib/money";
import { toWhatsAppNumber } from "../lib/reminders";
import { priceForSession } from "../lib/workflow";

// DB-free protocol tests. Real guard and exact source-extracted domain bodies run
// against a deterministic query double, never db.ts bootstrap or a SQL engine.
// PostgreSQL locking/rollback behavior is proven only by the separate CI suite.
const queryClient = (doctors: number[]) => {
  const query = vi.fn(async (_sql: string, values: unknown[] = []) => ({
    rows: (values[0] as number[]).filter((id) => doctors.includes(id)).map((id) => ({ id })),
  }));
  return { query, release: vi.fn() } as unknown as DbClient & { query: typeof query };
};

describe("clinical performer identity under the caller's transaction", () => {
  it.each([0, -1, 1.5, NaN, Infinity, 2_147_483_648])("rejects explicit malformed party ID %s before SQL", async (id) => {
    const client = queryClient([11]);
    await expect(lockClinicalDoctors(client, [id])).rejects.toBeInstanceOf(ClinicalDoctorIdentityConflict);
    expect(client.query).not.toHaveBeenCalled();
  });
  it.each([91, 92, 93])("rejects missing/non-doctor explicit %s despite a valid fallback", async (id) => {
    await expect(lockClinicalDoctors(queryClient([11]), [id], [11])).rejects.toMatchObject({ code: "invalid_procedure_doctor" });
  });
  it("locks one sorted union with canonical kind semantics, retaining inactive real doctors", async () => {
    const client = queryClient([11, 12]);
    expect(await lockClinicalDoctors(client, [12, 11, 12, null], [91, 11])).toEqual(new Set([11, 12]));
    expect(client.query).toHaveBeenCalledExactlyOnceWith(
      "SELECT id FROM parties WHERE id = ANY($1::int[]) AND kind = 'doctor' ORDER BY id FOR SHARE", [[11, 12, 91]],
    );
  });
  it("ignores invalid fallback parties without silently replacing explicit performers", async () => {
    expect(await lockClinicalDoctors(queryClient([12]), [12], [91])).toEqual(new Set([12]));
    expect(await lockClinicalDoctors(queryClient([]), [null], [91])).toEqual(new Set());
  });
  it("keeps null/omitted performers and no candidates free of extra SQL", async () => {
    const client = queryClient([]);
    expect(await lockClinicalDoctors(client, [null, undefined])).toEqual(new Set());
    expect(client.query).not.toHaveBeenCalled();
  });
});

const source = readFileSync("lib/db.ts", "utf8");
const parsed = ts.createSourceFile("db.ts", source, ts.ScriptTarget.Latest, true);
function domain<T>(name: string, dependencies: Record<string, unknown>): T {
  const node = parsed.statements.find((statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name);
  if (!node) throw new Error(`Missing real domain function: ${name}`);
  const compiled = ts.transpileModule(node.getFullText(parsed), {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const output: Record<string, unknown> = {};
  const load = (name: string) => {
    if (name === "./endodontics-db") return { hasMeaningfulEndoVisit: async () => false };
    throw new Error(`Unexpected dependency in isolated domain protocol: ${name}`);
  };
  // Private helpers use the same exact-source extraction as exported domain functions.
  const exposed = `${compiled}\nexports[${JSON.stringify(name)}] = ${name};`;
  new Function("exports", "require", ...Object.keys(dependencies), exposed)(output, load, ...Object.values(dependencies));
  return output[name] as T;
}

type Procedure = { id: number; serviceId: number; doctorId: number | null; toothCode: number | null;
  surfaces: string | null; quantity: number; unitPriceMinor: number; totalMinor: number; planItemId: number | null;
  serviceName: string; category: string | null; note: string | null; planCurrency: null };
const procedure = (doctorId: number | null, price = 100): Procedure => ({
  id: 501, serviceId: 401, serviceName: "Synthetic filling", category: "filling", doctorId,
  toothCode: 11, surfaces: null, quantity: 1, unitPriceMinor: price, totalMinor: price, planItemId: null,
  note: null, planCurrency: null,
});
const notes = { chiefComplaint: null, examination: null, diagnosis: "Synthetic diagnosis", treatmentDone: null,
  nextPlan: null, doctorId: 11 };

function protocol(line: Procedure, visitDoctor: number | null = 11) {
  let state = { procedures: [line], doctorId: visitDoctor, diagnosis: "Original diagnosis", signed: false,
    invoiceDoctors: [] as (number | null)[], invoiceCount: 0 };
  let before = structuredClone(state);
  const writeEffects = vi.fn(async () => 0);
  const query = vi.fn(async (sql: string, values: unknown[] = []) => {
    if (sql === "BEGIN") before = structuredClone(state);
    if (sql === "ROLLBACK") state = structuredClone(before);
    if (sql === "SELECT patient_id, patient_phone FROM visits WHERE id = $1") {
      return { rows: [{ patient_id: 101, patient_phone: null }] };
    }
    if (sql === "SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE") return { rows: [{ id: 101 }] };
    if (sql.includes("FROM parties")) return { rows: (values[0] as number[]).filter((id) => [11, 12].includes(id)).map((id) => ({ id })) };
    if (sql.includes("FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE")) return { rows: state.signed ? [] : [{
      id: 201, patient_id: 101, patient_name: "Synthetic patient", patient_phone: null, planned_visit_id: null,
      appointment_id: null, doctor_id: state.doctorId, diagnosis: state.diagnosis, treatment_done: null, billing_currency: "YER",
    }] };
    if (sql.includes("FROM visit_procedures p JOIN services")) return { rows: state.procedures.map((p) => ({
      id: p.id, service_id: p.serviceId, service_name: p.serviceName, category: p.category,
      doctor_id: p.doctorId, tooth_code: p.toothCode, surfaces: p.surfaces, quantity: p.quantity,
      unit_price_minor: String(p.unitPriceMinor), plan_item_id: p.planItemId, note: null, plan_currency: null,
    })) };
    if (sql.startsWith("UPDATE visits SET chief_complaint")) {
      state.diagnosis = String(values[3]); state.doctorId = values[6] as number | null ?? state.doctorId;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("DELETE FROM visit_procedures")) state.procedures = [];
    if (sql.includes("INSERT INTO visit_procedures")) state.procedures.push({ ...procedure(values[2] as number | null, values[6] as number),
      serviceId: values[1] as number, toothCode: values[3] as number | null, planItemId: values[8] as number | null });
    if (sql.startsWith("UPDATE visit_procedures SET doctor_id")) state.procedures[0].doctorId = values[1] as number;
    if (sql.includes("INSERT INTO invoices")) { state.invoiceCount++; return { rows: [{ id: 701 }] }; }
    if (sql.includes("INSERT INTO invoice_items")) state.invoiceDoctors.push(values[2] as number | null);
    if (sql.startsWith("UPDATE visits SET signed_at")) state.signed = true;
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: vi.fn() } as unknown as DbClient;
  const dependencies: Record<string, unknown> = {
    ensureSchema: async () => {}, getPool: () => ({ connect: async () => client, query }),
    lockClinicalDoctors, isCurrency, requireCurrency, priceForSession, CLINIC_BASE_CURRENCY: "YER",
    loadPlanItemsForPricing: async () => new Map(), normalizeSurfaces: (value: unknown) => value,
    ClinicalPlanConflict: class extends Error {},
    getClinicalVisit: async () => ({ id: 201, patientId: 101, patientName: "Synthetic patient", status: state.signed ? "signed" : "open",
      diagnosis: state.diagnosis, procedures: structuredClone(state.procedures), ortho: null, invoiceId: state.invoiceCount ? 701 : null,
      arrivedAt: "2026-10-06T07:00:00.000Z", doctorId: state.doctorId }),
    canSign: () => ({ ok: true }), resolveVisitPatient: async () => 101,
    toProcedureLine: (row: Record<string, unknown>) => ({ ...procedure(row.doctor_id as number | null, Number(row.unit_price_minor)),
      id: row.id, planItemId: row.plan_item_id }),
    classifyLinkedProcedureLines: async () => new Map(), visitTotal: (lines: Procedure[]) => lines.reduce((sum, row) => sum + row.totalMinor, 0),
    unlinkedPlanSessionConflicts: async () => [],
    progressTreatmentSessions: vi.fn(async () => ({ sessionsCompleted: 0, itemsDone: 0, touchedItemIds: [], byProcedure: new Map() })),
    matchPlanItems: () => [], unmetPlanItemRequirements: async () => new Map(),
    documentNumberSql: () => "'SYNTHETIC-INVOICE'", conditionForCategory: () => null,
    closePlannedVisitAndSuggestNext: async () => null, createAutoLabOrders: writeEffects,
    deductServiceMaterials: writeEffects, progressReferralsOnSign: writeEffects,
  };
  dependencies.normalizePatientPhone = domain("normalizePatientPhone", { toWhatsAppNumber });
  dependencies.phoneLookupForms = domain("phoneLookupForms", { toWhatsAppNumber });
  dependencies.lockVisitPatientFirst = domain("lockVisitPatientFirst", dependencies);
  dependencies.saveClinicalNotes = domain("saveClinicalNotes", dependencies);
  return { state: () => structuredClone(state), query, writeEffects, dependencies,
    save: domain<(input: Record<string, unknown>) => Promise<boolean>>("setVisitProcedures", dependencies),
    sign: domain<(input: Record<string, unknown>) => Promise<{ reason: string | null; invoiceId: number | null }>>("signClinicalVisit", dependencies),
  };
}

function expectPatientFirst(query: ReturnType<typeof protocol>["query"]) {
  expect(query.mock.calls.slice(0, 3)).toEqual([
    ["BEGIN"],
    ["SELECT patient_id, patient_phone FROM visits WHERE id = $1", [201]],
    ["SELECT id FROM patients WHERE id = $1 FOR NO KEY UPDATE", [101]],
  ]);
  const visitLock = query.mock.calls.findIndex(([sql]) =>
    sql.includes("FROM visits WHERE id = $1 AND signed_at IS NULL FOR UPDATE"));
  expect(visitLock).toBe(3);
  expect(query.mock.calls[visitLock]?.[1]).toEqual([201]);
}

describe("exact domain bodies reject bad performer identities without effects (query protocol)", () => {
  it.each([91, 92, 93])("save refuses explicit non-doctor/missing %s and keeps existing notes and procedures", async (id) => {
    const p = protocol(procedure(12)); const before = p.state();
    await expect(p.save({ visitId: 201, procedures: [procedure(id)], clinicalNotes: notes }))
      .rejects.toBeInstanceOf(ClinicalDoctorIdentityConflict);
    expectPatientFirst(p.query);
    expect(p.state()).toEqual(before);
    expect(p.query.mock.calls.some(([sql]) => /DELETE FROM visit_procedures|UPDATE visits SET chief_complaint/.test(sql))).toBe(false);
  });
  it("valid save combines notes/procedures on the owned transaction and preserves explicit doctor B", async () => {
    const p = protocol(procedure(11));
    expect(await p.save({ visitId: 201, procedures: [procedure(12)], clinicalNotes: notes })).toBe(true);
    expectPatientFirst(p.query);
    expect(p.state()).toMatchObject({ diagnosis: notes.diagnosis, doctorId: 11, procedures: [expect.objectContaining({ doctorId: 12 })] });
    const statements = p.query.mock.calls.map(([sql]) => sql);
    expect(statements.indexOf("COMMIT")).toBeGreaterThan(statements.findIndex((sql) => sql.startsWith("UPDATE visits SET chief_complaint")));
  });
  it.each([[91, 11, 100], [92, null, 100], [91, 11, 0]] as const)(
    "sign refuses explicit %s with visit doctor %s and price %s before any downstream effect", async (id, doctor, price) => {
      const p = protocol(procedure(id, price), doctor); const before = p.state();
      await expect(p.sign({ visitId: 201, baseCurrency: "YER", signedBy: "synthetic-admin", signerDoctorPartyId: 12 }))
        .rejects.toBeInstanceOf(ClinicalDoctorIdentityConflict);
      expectPatientFirst(p.query);
      expect(p.state()).toEqual(before); expect(p.writeEffects).not.toHaveBeenCalled();
      expect(p.dependencies.progressTreatmentSessions).not.toHaveBeenCalled();
      expect(p.query.mock.calls.at(-1)?.[0]).toBe("ROLLBACK");
    },
  );
  it.each([[12, 11, 11, 12], [null, 11, 12, 11], [null, null, 12, 12]] as const)(
    "keeps explicit/null fallback attribution %s/%s/%s → %s", async (explicit, doctor, signer, expected) => {
      const p = protocol(procedure(explicit), doctor);
      expect((await p.sign({ visitId: 201, baseCurrency: "YER", signedBy: "synthetic", signerDoctorPartyId: signer })).reason).toBeNull();
      expectPatientFirst(p.query);
      expect(p.state()).toMatchObject({ signed: true, invoiceDoctors: [expected], procedures: [expect.objectContaining({ doctorId: expected })] });
    },
  );
  it("keeps the no-treating-doctor refusal when all fallbacks are non-doctors", async () => {
    const p = protocol(procedure(null), 91);
    expect((await p.sign({ visitId: 201, baseCurrency: "YER", signedBy: "synthetic", signerDoctorPartyId: 92 })).reason).toBe("no_treating_doctor");
    expectPatientFirst(p.query);
    expect(p.state()).toMatchObject({ signed: false, invoiceCount: 0 });
  });
});
