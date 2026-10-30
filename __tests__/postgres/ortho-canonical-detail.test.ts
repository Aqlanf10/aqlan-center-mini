/** Slice 30: real PostgreSQL, isolated synthetic records; a read never repairs a case. */
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { capabilityDocument, waitForBlockedBy } from "./_canonical-ready-fixture";
vi.mock("server-only", () => ({}));
assertRealPostgresUrl(); stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-ortho-cases-20261030-secret");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-ortho-reads");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const VIEW = { "clinical.ortho.view": true };
const ACCOUNTS = {
  owner: { username: "SYN-OD-OWNER", role: "admin" },
  own: { username: "SYN-OD-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  manager: { username: "SYN-OD-MANAGER", role: "admin", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-OD-ALL", role: "reception", patientScope: "all", grants: VIEW },
  adjacent: { username: "SYN-OD-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.xrays.view": true } },
  none: { username: "SYN-OD-NONE", role: "doctor", doctor: true, patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-OD-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0, empty: 0, active: 0, closed: 0, foreignCase: 0 };
const read = async (key: Key, patientId: number | null = null) => reads.readCanonicalOrthoCase(await fx.session(key), patientId ?? ids.active);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["own", "outside", "empty"] as const) {
    ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-OD-${key}`, `SYN Patient ${key}`, key === "outside" ? null : fx.parties.own!])).rows[0].id;
  }
  ids.closed = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,note) VALUES($1,'completed','2024-01-01','SYN','SYN-private-note') RETURNING id", [ids.own])).rows[0].id;
  ids.active = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,start_date,created_by,upper_wire,responsible_doctor_id) VALUES($1,'2026-01-01','SYN','SYN-wire-old',$2) RETURNING id", [ids.own, fx.parties.manager!])).rows[0].id;
  ids.foreignCase = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [ids.outside])).rows[0].id;
  await fx.pool.query("INSERT INTO ortho_adjustments(case_id,recorded_by,note) VALUES($1,'SYN','SYN-private-adjustment')", [ids.active]);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });

it("registers only the ortho view grant and patient scope", () => {
  expect(CANONICAL_RECORD_READS["read:ortho.case"]).toEqual({ record: "patient", need: ["clinical.ortho.view"], anyOf: [] });
});
it("own scope uses central patient witnesses and does not substitute the requesting doctor", async () => {
  expect((await read("own")).case).toMatchObject({ id: ids.active, patientId: ids.own, responsibleDoctorId: fx.parties.manager });
  expect((await read("manager")).case.id).toBe(ids.active);
  await expect(read("manager", ids.foreignCase)).rejects.toMatchObject({ code: "patient_not_found" });
});
it.each(["all", "owner"] as const)("%s sees active and closed native clinical history without independent field groups", async key => {
  const result = await read(key);
  expect(result).toMatchObject({ projection: "case-clinical", hasMore: false, progress: { adjustments: 1 }, adjustments: [expect.objectContaining({ note: "SYN-private-adjustment" })] });
  expect((await read(key, ids.closed)).case.note).toBe("SYN-private-note");
  expect(Object.keys(result).sort()).toEqual(["projection", "case", "adjustments", "hasMore", "progress", "today"].sort());
  expect(Object.keys(result.case).sort()).toEqual(["id", "patientId", "patientName", "appliance", "arches", "slot", "bracketSystem", "status", "phase", "startDate", "plannedMonths", "upperWire", "lowerWire", "retainer", "retainerOn", "note", "closedAt", "closedNote", "baselineKind", "baselineRecordedAt", "elastics", "remainingObjectives", "responsibleDoctorId", "responsibleDoctorName"].sort());
  expect(Object.keys(result.adjustments[0]).sort()).toEqual(["id", "doneOn", "phase", "upperWire", "lowerWire", "elastics", "elasticNote", "done", "nextWeeks", "note", "recordedBy"].sort());
  expect(JSON.stringify(result)).not.toMatch(/planId|legacyFinancialMode|photos|visitId|visitSigned|closedBy|invoice|balance/);
});
it.each(["adjacent", "none", "unlinked"] as const)("denies %s instead of widening by role or adjacent grants", async key => {
  await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED|PROVIDER/);
});
it("outside scope and missing cases have the same bounded refusal", async () => {
  const errors = [];
  for (const id of [ids.foreignCase, 2147483647]) {
    try { await read("own", id); throw new Error("unexpected success"); } catch (error) { errors.push({ code: (error as { code: string }).code, message: (error as Error).message }); }
  }
  expect(errors[0]).toEqual(errors[1]); expect(errors[0].code).toBe("patient_not_found");
});
it.each(["0", "-1", "01", "1e2", "2147483648", "9007199254740992"])("rejects noncanonical or out-of-range case id %s", id => {
  expect(() => reads.canonicalOrthoCaseId(id, new URLSearchParams())).toThrow();
});
it("rejects all query expansions even for independently granted fields", () => {
  expect(reads.canonicalOrthoCaseId("123", new URLSearchParams())).toBe(123);
  for (const query of ["photos=1", "planId=1", "patientId=1", "doctorId=1", "include=notes"]) expect(() => reads.canonicalOrthoCaseId("123", new URLSearchParams(query))).toThrow();
});
it("uses one read-only RR lease and never touches independent tables, schema, audit or financial writers", async () => {
  const before = (await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM clinical_cases)::int AS bridges")).rows;
  const session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), original = db.getOrthoClinicalDetailWith;
  const statements: string[] = [];
  const reader = vi.spyOn(db, "getOrthoClinicalDetailWith").mockImplementationOnce(async (q, id, clinician, today) => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    const traced = { query: ((...args: Parameters<typeof q.query>) => { statements.push(String(args[0])); return q.query(...args); }) as typeof q.query };
    return original(traced, id, clinician, today);
  });
  try {
    await reads.readCanonicalOrthoCase(session, ids.active);
    expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled();
    // The central membership predicate legitimately references plan/visit ids; the
    // domain projection must not join/fetch those records or any document payload.
    expect(statements).toHaveLength(3);
    expect(statements.join(" ")).not.toMatch(/JOIN visits|JOIN treatment_plans|patient_documents|plan_id|legacy_financial_mode|INSERT |UPDATE |DELETE |CREATE /i);
  } finally { connect.mockRestore(); query.mockRestore(); reader.mockRestore(); }
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM clinical_cases)::int AS bridges")).rows).toEqual(before);
});
it("membership, case values, count and adjustments remain in one snapshot during concurrent transfer and edit", async () => {
  const original = db.getOrthoClinicalDetailWith;
  const reader = vi.spyOn(db, "getOrthoClinicalDetailWith").mockImplementationOnce(async (q, id, clinician, today) => {
    let first = true;
    const wrapped = { query: (async (...args: Parameters<typeof q.query>) => {
      const result = await q.query(...args);
      if (first) {
        first = false;
        const writer = await side.connect();
        try {
          await writer.query("BEGIN");
          await writer.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.own]);
          await writer.query("UPDATE ortho_cases SET upper_wire='SYN-new-wire' WHERE id=$1", [ids.active]);
          await writer.query("UPDATE ortho_adjustments SET note='SYN-new-note' WHERE case_id=$1", [ids.active]);
          await writer.query("COMMIT");
        } finally { await writer.query("ROLLBACK"); writer.release(); }
      }
      return result;
    }) as typeof q.query };
    return original(wrapped, id, clinician, today);
  });
  try {
    const detail = await read("own");
    expect(detail.case.upperWire).toBe("SYN-wire-old"); expect(detail.adjustments[0].note).toBe("SYN-private-adjustment");
    reader.mockRestore();
    await expect(read("own")).rejects.toMatchObject({ code: "patient_not_found" });
    expect((await read("all")).adjustments[0].note).toBe("SYN-new-note");
  } finally {
    reader.mockRestore(); await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own!, ids.own]);
    await side.query("UPDATE ortho_cases SET upper_wire='SYN-wire-old' WHERE id=$1", [ids.active]);
    await side.query("UPDATE ortho_adjustments SET note='SYN-private-adjustment' WHERE case_id=$1", [ids.active]);
  }
});
it("expires a session waiting behind the real lifecycle fence", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalOrthoCase(session, ids.active); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); await new Promise(resolve => setTimeout(resolve, 1700)); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/SESSION|EXPIRED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); }
});
it("re-proves permissions after waiting behind revocation; new sessions cannot regain access from a role label", async () => {
  const stale = await fx.session("all"), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    await holder.query("UPDATE users SET permissions=$1 WHERE id=$2", [JSON.stringify(capabilityDocument({ grants: {}, patientScope: "all" }, 2)), fx.ids.all]);
    const pending = reads.readCanonicalOrthoCase(stale, ids.active); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/);
    await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("rejects scope revocation and inactive clinician links on subsequent reads", async () => {
  const stale = await fx.session("own");
  await fx.setGrants("own", VIEW, { patientScope: "none" });
  try { await expect(reads.readCanonicalOrthoCase(stale, ids.active)).rejects.toThrow(/STALE/); await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/); }
  finally { await fx.setGrants("own", VIEW, { patientScope: "own" }); }
  await fx.pool.query("UPDATE parties SET is_active=FALSE WHERE id=$1", [fx.parties.own!]);
  try { await expect(read("own")).rejects.toThrow("STAFF_OPERATION_PROVIDER_STALE"); }
  finally { await fx.pool.query("UPDATE parties SET is_active=TRUE WHERE id=$1", [fx.parties.own!]); }
});
it("failure rejects the entire result and releases the lease for the next read", async () => {
  const reader = vi.spyOn(db, "getOrthoClinicalDetailWith").mockImplementationOnce(q => q.query("SELECT 1/0").then(() => null));
  try { await expect(read("own")).rejects.toThrow(); } finally { reader.mockRestore(); }
  expect((await read("own")).case.id).toBe(ids.active);
});
it("bounds history honestly while progress uses all adjustments, including none and closed cases", async () => {
  expect((await read("own", ids.closed)).adjustments).toEqual([]);
  const inserted = (await fx.pool.query("INSERT INTO ortho_adjustments(case_id,done_on,recorded_by,note) SELECT $1,'2026-01-01','SYN','SYN-bulk-'||n FROM generate_series(1,105) n RETURNING id", [ids.closed])).rows.map(r => r.id);
  try {
    const detail = await read("own", ids.closed);
    expect(detail.adjustments).toHaveLength(100); expect(detail.hasMore).toBe(true); expect(detail.progress.adjustments).toBe(105);
    expect(detail.adjustments.map(a => a.id)).toEqual([...inserted].sort((a,b) => b-a).slice(0,100));
  } finally { await fx.pool.query("DELETE FROM ortho_adjustments WHERE id=ANY($1::int[])", [inserted]); }
});
it("rejects an oversized clinical result without silently truncating clinical notes", async () => {
  await fx.pool.query("UPDATE ortho_cases SET note=repeat('x',1100000) WHERE id=$1", [ids.active]);
  try { await expect(read("own")).rejects.toThrow(/SIZE|LARGE|BOUND/); }
  finally { await fx.pool.query("UPDATE ortho_cases SET note=NULL WHERE id=$1", [ids.active]); }
});
it("legacy full reader and independent financial fields remain unchanged", async () => {
  await fx.pool.query("UPDATE ortho_cases SET legacy_financial_mode='installments' WHERE id=$1", [ids.closed]);
  const old = await db.getOrthoCase(ids.closed, "2026-10-30");
  expect(old).toMatchObject({ legacyFinancialMode: "installments", note: "SYN-private-note", planId: null });
  expect(JSON.stringify(await read("owner", ids.closed))).not.toContain("installments");
});
