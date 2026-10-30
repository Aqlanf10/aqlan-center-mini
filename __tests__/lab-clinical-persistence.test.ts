import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LabClinicalSnapshot } from "../lib/lab-clinical-edit";
import type { SessionPayload } from "../lib/auth";

const boundary = vi.hoisted(() => ({ query: vi.fn(), poolQuery: vi.fn(), connect: vi.fn(), release: vi.fn(), end: vi.fn() }));
vi.mock("pg", () => ({ Pool: class { query = boundary.poolQuery; connect = boundary.connect; end = boundary.end; } }));
vi.mock("@electric-sql/pglite", () => ({ PGlite: class { constructor() { throw new Error("No database connection permitted in this synthetic boundary suite"); } } }));
import { ensureSchema, resetPoolForTesting, updateLabOrderClinical } from "../lib/db";

const snapshot = (): LabClinicalSnapshot => ({ doctorId: 7, workType: "طقم جزئي", toothNumbers: "11(Crown)",
  shade: "OM3", shadeSpecification: null, partyId: 9, labName: "Synthetic lab", labPhone: null });
const originalRow = () => ({ patient_id: 13, doctor_id: 7 as number | null, work_type: "طقم جزئي", tooth_numbers: "11(Crown)",
  shade: "OM3", shade_specification: null, party_id: 9, lab_name: "Synthetic lab", lab_phone: null,
  cost_minor: null as string | null, payable_id: null as number | null });
let row: ReturnType<typeof originalRow> | null;
let linked: boolean, invoice: boolean, doctorActive: boolean, auditFailure: boolean, history: boolean;
const session = (): SessionPayload => ({ userId: 1, username: "synthetic-admin", role: "admin", expiresAt: Date.now() + 60_000 });
const corrected = (): LabClinicalSnapshot => ({ ...snapshot(), toothNumbers: "11(Denture Tooth)" });
const call = (clinical = corrected(), expectedClinical = snapshot(), principal = session()) =>
  updateLabOrderClinical(21, { clinical, expectedClinical, session: principal });
const mutations = () => boundary.query.mock.calls.filter(([sql]) => /UPDATE lab_orders|INSERT INTO audit_log|UPDATE payables|INSERT INTO payables/.test(sql));

beforeEach(async () => {
  vi.clearAllMocks();
  vi.stubEnv("DATABASE_URL", "postgresql://synthetic@127.0.0.1:54329/aqlan_p1_test?sslmode=disable");
  vi.stubEnv("USE_LOCAL_DB", undefined); vi.stubEnv("RAILWAY_PROJECT_ID", undefined); vi.stubEnv("SKIP_SEED", "true");
  boundary.end.mockResolvedValue(undefined); await resetPoolForTesting();
  boundary.poolQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  boundary.query.mockImplementation(async (sql: string) => ({ rows: sql.includes("AS present") ? [{ present: false }] : [] }));
  boundary.connect.mockResolvedValue({ query: boundary.query, release: boundary.release });
  await ensureSchema();
  boundary.poolQuery.mockClear(); boundary.query.mockClear(); boundary.connect.mockClear(); boundary.release.mockClear();
  row = originalRow(); linked = false; invoice = false; doctorActive = true; auditFailure = false; history = false;
  boundary.query.mockImplementation(async (sql: string) => {
    if (/FROM lab_orders WHERE id=\$1 FOR UPDATE/.test(sql)) return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    if (/kind='doctor'/.test(sql)) return { rows: doctorActive ? [{ id: 7 }] : [], rowCount: doctorActive ? 1 : 0 };
    if (/SELECT id FROM payables WHERE lab_order_id/.test(sql)) return { rows: linked ? [{ id: 77 }] : [], rowCount: linked ? 1 : 0 };
    if (/SELECT id FROM lab_order_tracking/.test(sql)) return { rows: history ? [{ id: 99 }] : [], rowCount: history ? 1 : 0 };
    if (/SELECT v.invoice_id/.test(sql)) return { rows: invoice ? [{ invoice_id: 88 }] : [], rowCount: invoice ? 1 : 0 };
    if (/kind='lab'/.test(sql)) return { rows: [{ name: "Synthetic new lab", phone: null }], rowCount: 1 };
    if (/INSERT INTO audit_log/.test(sql) && auditFailure) throw new Error("Synthetic audit failure");
    return { rows: [], rowCount: 0 };
  });
});
afterEach(async () => { await resetPoolForTesting(); vi.unstubAllEnvs(); });

describe("actual lab clinical writer with synthetic SQL boundaries", () => {
  it("explicitly fixes saved crown roles for denture work and audits without touching money", async () => {
    expect(await call()).toBe("updated");
    const update = boundary.query.mock.calls.find(([sql]) => /UPDATE lab_orders SET/.test(sql))!;
    expect(update[1]).toEqual([21, 7, "طقم جزئي", "11(Denture Tooth)", "OM3", null, 9, "Synthetic lab", null]);
    expect(update[0]).not.toMatch(/cost_minor|base_amount|exchange_rate|payable_id|financial_status|is_posted/);
    const audit = boundary.query.mock.calls.find(([sql]) => /INSERT INTO audit_log/.test(sql))!;
    expect(audit[1]).toContain("lab_order.clinical"); expect(audit[1]).toContain("synthetic-admin");
    expect(audit[1].some((value: unknown) => typeof value === "string" && value.includes('"financialSnapshotUnchanged":true'))).toBe(true);
    expect(boundary.query.mock.calls.at(-1)).toEqual(["COMMIT"]);
  });
  it("allows explicit tooth correction on a funded order without changing the saved doctor or lab", async () => {
    row!.cost_minor = "2500"; row!.payable_id = 77; linked = true; invoice = true;
    expect(await call()).toBe("updated");
    expect(boundary.query.mock.calls.some(([sql]) => /UPDATE payables|INSERT INTO payables|UPDATE invoices/.test(sql))).toBe(false);
  });
  it("accepts an exact valid no-op without update or audit", async () => {
    row!.tooth_numbers = "11(Denture Tooth)";
    expect(await call(corrected(), corrected())).toBe("updated"); expect(mutations()).toEqual([]);
  });
  it("rejects stale observed clinical values without writing", async () => {
    expect(await call(corrected(), { ...snapshot(), shade: "A2" })).toBe("conflict"); expect(mutations()).toEqual([]);
  });
  it("rejects an expired real patient-access session", async () => {
    expect(await call(corrected(), snapshot(), { ...session(), expiresAt: Date.now() - 1 })).toBe("forbidden");
    expect(mutations()).toEqual([]);
  });
  it("denies a doctor who cannot access this patient through the real ownership gate", async () => {
    expect(await call(corrected(), snapshot(), { ...session(), role: "doctor", partyId: 7 })).toBe("forbidden");
    expect(mutations()).toEqual([]);
  });
  it("denies a nonclinical role before opening a transaction", async () => {
    expect(await call(corrected(), snapshot(), { ...session(), role: "cashier" })).toBe("forbidden");
    expect(boundary.connect).not.toHaveBeenCalled();
  });
  it("returns not_found for a missing order", async () => { row = null; expect(await call()).toBe("not_found"); expect(mutations()).toEqual([]); });
  it.each(["cost", "payable", "linked"])("blocks changing a financially implicated lab: %s", async type => {
    if (type === "cost") row!.cost_minor = "0";
    if (type === "payable") row!.payable_id = 77;
    if (type === "linked") linked = true;
    expect(await call({ ...corrected(), partyId: 10, labName: "Synthetic new lab" })).toBe("financial_lab_locked");
    expect(mutations()).toEqual([]);
  });
  it.each(["cost", "payable", "linked", "invoice"])("blocks doctor reattribution with financial history: %s", async type => {
    if (type === "cost") row!.cost_minor = "0";
    if (type === "payable") row!.payable_id = 77;
    if (type === "linked") linked = true;
    if (type === "invoice") invoice = true;
    expect(await call({ ...corrected(), doctorId: 8 })).toBe("financial_doctor_locked"); expect(mutations()).toEqual([]);
  });
  it("allows unfinanced canonical active lab correction, but rejects an altered name", async () => {
    expect(await call({ ...corrected(), partyId: 10, labName: "Synthetic new lab" })).toBe("updated");
    boundary.query.mockClear();
    expect(await call({ ...corrected(), partyId: 10, labName: "Unverified name" })).toBe("invalid"); expect(mutations()).toEqual([]);
  });
  it("does not guess a role correction or reinterpret a legacy colour", async () => {
    expect(await call(snapshot())).toBe("invalid"); expect(mutations()).toEqual([]);
    expect(await call({ ...corrected(), shade: "arbitrary new code" })).toBe("invalid"); expect(mutations()).toEqual([]);
  });
  it("requires an active newly assigned doctor", async () => { doctorActive = false; expect(await call({ ...snapshot(), doctorId: 8 })).toBe("invalid"); expect(mutations()).toEqual([]); });
  it("preserves unchanged inactive doctor while correcting other fields", async () => { doctorActive = false; expect(await call()).toBe("updated"); });
  it("rolls back the clinical update if atomic audit insertion fails", async () => {
    auditFailure = true; await expect(call()).rejects.toThrow("Synthetic audit failure");
    expect(boundary.query.mock.calls.some(([sql]) => /UPDATE lab_orders/.test(sql))).toBe(true);
    expect(boundary.query.mock.calls.at(-1)).toEqual(["ROLLBACK"]); expect(boundary.release).toHaveBeenCalledOnce();
  });
});

it("allows other corrections while retaining missing legacy doctor even with financial links", async () => {
  row!.doctor_id = null; row!.cost_minor = "2500"; row!.payable_id = 77; linked = true; invoice = true;
  const expected = { ...snapshot(), doctorId: null };
  expect(await call({ ...expected, toothNumbers: "11(Denture Tooth)" }, expected)).toBe("updated");
});

it("retains financial guards for legacy tracking-only settlement/reversal history", async () => {
  history = true;
  expect(await call({ ...corrected(), doctorId: 8 })).toBe("financial_doctor_locked");
  expect(await call({ ...corrected(), partyId: 10, labName: "Synthetic new lab" })).toBe("financial_lab_locked");
  expect(mutations()).toEqual([]);
});
