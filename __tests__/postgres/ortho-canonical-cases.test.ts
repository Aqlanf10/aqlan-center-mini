/** Slice 29: real PostgreSQL, isolated synthetic records; a read never repairs a case. */
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
  owner: { username: "SYN-OC-OWNER", role: "admin" },
  own: { username: "SYN-OC-OWN", role: "doctor", doctor: true, patientScope: "own", grants: VIEW },
  manager: { username: "SYN-OC-MANAGER", role: "admin", doctor: true, patientScope: "own", grants: VIEW },
  all: { username: "SYN-OC-ALL", role: "reception", patientScope: "all", grants: VIEW },
  adjacent: { username: "SYN-OC-ADJACENT", role: "admin", patientScope: "all", grants: { "clinical.plans.view": true, "clinical.xrays.view": true } },
  none: { username: "SYN-OC-NONE", role: "doctor", doctor: true, patientScope: "none", grants: VIEW },
  unlinked: { username: "SYN-OC-UNLINKED", role: "doctor", patientScope: "own", grants: VIEW },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>, side: Pool;
const ids = { own: 0, outside: 0, empty: 0, active: 0, closed: 0, foreignCase: 0 };
const read = async (key: Key, patientId: number | null = null) => reads.readCanonicalOrthoCases(await fx.session(key), patientId);
beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  side = new Pool({ connectionString: fx.pool.options.connectionString, max: 3 });
  for (const key of ["own", "outside", "empty"] as const) {
    ids[key] = (await fx.pool.query("INSERT INTO patients(patient_number,full_name,primary_doctor_id) VALUES($1,$2,$3) RETURNING id", [`SYN-OC-${key}`, `SYN Patient ${key}`, key === "outside" ? null : fx.parties.own!])).rows[0].id;
  }
  ids.closed = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,status,start_date,created_by,note) VALUES($1,'completed','2024-01-01','SYN','SYN-private-note') RETURNING id", [ids.own])).rows[0].id;
  ids.active = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,start_date,created_by,upper_wire,responsible_doctor_id) VALUES($1,'2026-01-01','SYN','SYN-wire-old',$2) RETURNING id", [ids.own, fx.parties.manager!])).rows[0].id;
  ids.foreignCase = (await fx.pool.query("INSERT INTO ortho_cases(patient_id,created_by) VALUES($1,'SYN') RETURNING id", [ids.outside])).rows[0].id;
  await fx.pool.query("INSERT INTO ortho_adjustments(case_id,recorded_by,note) VALUES($1,'SYN','SYN-private-adjustment')", [ids.active]);
}, 180_000);
afterAll(async () => { await side?.end(); await fx?.close(); });

it("registers exactly the mapped grant and patient record scope", () => {
  expect(CANONICAL_RECORD_READS["read:ortho.cases"]).toEqual({ record: "patient", need: ["clinical.ortho.view"], anyOf: [] });
});
it("own scope lists its patients even when another doctor is responsible; the summary does not reassign anyone", async () => {
  const view = await read("own");
  expect(view.cases.map(row => row.id)).toEqual([ids.active]);
  expect(view.cases[0]).toMatchObject({ responsibleDoctorId: fx.parties.manager, upperWire: "SYN-wire-old" });
  expect((await fx.pool.query("SELECT primary_doctor_id FROM patients WHERE id=$1", [ids.own])).rows[0].primary_doctor_id).toBe(fx.parties.own);
});
it("all and the protected owner see the same summary; default list is open, filtered history includes closed cases", async () => {
  for (const key of ["all", "owner"] as const) {
    expect((await read(key)).cases.map(row => row.id).sort()).toEqual([ids.active, ids.foreignCase].sort());
    expect((await read(key, ids.own)).cases.map(row => row.id)).toEqual([ids.active, ids.closed]);
  }
});
it("the admin doctor stays within own patients, including the existing active ortho responsibility relationship", async () => {
  // Active responsibility is already one witness in the central patient predicate.
  expect((await read("manager")).cases.map(row => row.id)).toEqual([ids.active]);
  await expect(read("manager", ids.outside)).rejects.toMatchObject({ code: "patient_not_found" });
});
it.each(["adjacent", "none", "unlinked"] as const)("refuses %s before domain rows are read", async key => {
  const spy = vi.spyOn(db, "listOrthoCaseSummariesWith");
  try { await expect(read(key)).rejects.toThrow(/CAPABILITY_DENIED|RECORD_SCOPE_DENIED/); expect(spy).not.toHaveBeenCalled(); }
  finally { spy.mockRestore(); }
});
it("outside and missing patients have identical refusals, while a legitimate empty history succeeds", async () => {
  const outcomes = [];
  for (const id of [ids.outside, 2147483647]) {
    outcomes.push(await read("own", id).catch(error => ({ code: error.code, message: error.message })));
  }
  expect(outcomes[0]).toEqual(outcomes[1]); expect(outcomes[0]).toMatchObject({ code: "patient_not_found" });
  expect(await read("own", ids.empty)).toMatchObject({ cases: [], hasMore: false, projection: "case-summary" });
});
it("publishes an explicit summary allowlist, never funding, private notes, photos or adjustment history", async () => {
  const allowed = ["id", "patientId", "patientName", "appliance", "arches", "status", "phase", "startDate", "plannedMonths", "upperWire", "lowerWire", "responsibleDoctorId", "responsibleDoctorName", "baselineKind"].sort();
  for (const key of ["own", "owner"] as const) {
    const view = await read(key, ids.own);
    expect(Object.keys(view).sort()).toEqual(["cases", "hasMore", "projection", "today"]);
    for (const row of view.cases) expect(Object.keys(row).sort()).toEqual(allowed);
    expect(JSON.stringify(view)).not.toMatch(/SYN-private|legacyFinancialMode|planId|photos|adjustments/);
  }
});
it.each(["patientId=0", "patientId=-1", "patientId=01", "patientId=1&patientId=2", "patientId=9007199254740992", "doctorId=1", "status=active"])("rejects malformed or caller-selected filters: %s", query => {
  expect(() => reads.canonicalOrthoPatientFilter(new URLSearchParams(query))).toThrow();
});
it("accepts only an absent filter or a positive safe patient id", () => {
  expect(reads.canonicalOrthoPatientFilter(new URLSearchParams())).toBeNull();
  expect(reads.canonicalOrthoPatientFilter(new URLSearchParams("patientId=123"))).toBe(123);
});
it("uses one owning read-only repeatable-read lease, with no hidden pool reads or effects", async () => {
  const before = (await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM clinical_cases)::int AS bridges")).rows;
  const session = await fx.session("own"), pool = db.getPool();
  const connect = vi.spyOn(pool, "connect"), query = vi.spyOn(pool, "query"), original = db.listOrthoCaseSummariesWith;
  const reader = vi.spyOn(db, "listOrthoCaseSummariesWith").mockImplementationOnce(async (q, patientId, clinician) => {
    expect((await q.query("SHOW transaction_isolation")).rows[0].transaction_isolation).toBe("repeatable read");
    expect((await q.query("SHOW transaction_read_only")).rows[0].transaction_read_only).toBe("on");
    return original(q, patientId, clinician);
  });
  try { await reads.readCanonicalOrthoCases(session, ids.own); expect(connect).toHaveBeenCalledTimes(1); expect(query).not.toHaveBeenCalled(); }
  finally { connect.mockRestore(); query.mockRestore(); reader.mockRestore(); }
  expect((await fx.pool.query("SELECT (SELECT count(*) FROM audit_log)::int AS audits,(SELECT count(*) FROM invoices)::int AS invoices,(SELECT count(*) FROM clinical_cases)::int AS bridges")).rows).toEqual(before);
});
it("keeps membership and case values in the admitted snapshot during a concurrent patient transfer", async () => {
  const original = db.listOrthoCaseSummariesWith;
  const reader = vi.spyOn(db, "listOrthoCaseSummariesWith").mockImplementationOnce(async (q, patientId, clinician) => {
    const writer = await side.connect();
    try {
      await writer.query("BEGIN");
      await writer.query("UPDATE patients SET primary_doctor_id=NULL WHERE id=$1", [ids.own]);
      await writer.query("UPDATE ortho_cases SET upper_wire='SYN-wire-new' WHERE id=$1", [ids.active]);
      await writer.query("COMMIT");
    } finally { await writer.query("ROLLBACK"); writer.release(); }
    return original(q, patientId, clinician);
  });
  try {
    expect((await read("own", ids.own)).cases[0].upperWire).toBe("SYN-wire-old");
    reader.mockRestore();
    await expect(read("own", ids.own)).rejects.toMatchObject({ code: "patient_not_found" });
    expect((await read("all", ids.own)).cases[0].upperWire).toBe("SYN-wire-new");
  } finally { reader.mockRestore(); await side.query("UPDATE patients SET primary_doctor_id=$1 WHERE id=$2", [fx.parties.own!, ids.own]); await side.query("UPDATE ortho_cases SET upper_wire='SYN-wire-old' WHERE id=$1", [ids.active]); }
});
it("expires a session waiting behind the real lifecycle fence", async () => {
  const session = await fx.session("own", 1500), holder = await side.connect();
  try {
    await holder.query("BEGIN");
    const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await holder.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", ["aqlan.canonical.identity.substrate.v1:public"]);
    const pending = reads.readCanonicalOrthoCases(session, ids.own); pending.catch(() => undefined);
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
    const pending = reads.readCanonicalOrthoCases(stale, ids.own); pending.catch(() => undefined);
    try { expect((await waitForBlockedBy(side, pid, 7000)).length).toBeGreaterThan(0); }
    finally { await holder.query("COMMIT"); }
    await expect(pending).rejects.toThrow(/STALE/);
    await expect(read("all")).rejects.toThrow(/CAPABILITY_DENIED/);
  } finally { await holder.query("ROLLBACK"); holder.release(); await fx.setGrants("all", VIEW, { patientScope: "all" }); }
});
it("rejects scope revocation and inactive clinician links on subsequent reads", async () => {
  const stale = await fx.session("own");
  await fx.setGrants("own", VIEW, { patientScope: "none" });
  try { await expect(reads.readCanonicalOrthoCases(stale, ids.own)).rejects.toThrow(/STALE/); await expect(read("own")).rejects.toThrow(/RECORD_SCOPE_DENIED/); }
  finally { await fx.setGrants("own", VIEW, { patientScope: "own" }); }
  await fx.pool.query("UPDATE parties SET is_active=FALSE WHERE id=$1", [fx.parties.own!]);
  try { await expect(read("own")).rejects.toThrow("STAFF_OPERATION_PROVIDER_STALE"); }
  finally { await fx.pool.query("UPDATE parties SET is_active=TRUE WHERE id=$1", [fx.parties.own!]); }
});
it("fails the whole read on a domain error and leaves the next lease usable", async () => {
  const reader = vi.spyOn(db, "listOrthoCaseSummariesWith").mockImplementationOnce(q => q.query("SELECT 1/0").then(() => ({ cases: [], hasMore: false })));
  try { await expect(read("own")).rejects.toThrow(); } finally { reader.mockRestore(); }
  expect((await read("own")).cases.map(row => row.id)).toEqual([ids.active]);
});
it("preserves legacy full case readers, including their notes and adjustment history", async () => {
  const full = await db.listPatientOrthoCases(ids.own, "2026-10-30");
  expect(full.find(row => row.id === ids.closed)?.note).toBe("SYN-private-note");
  expect(full.find(row => row.id === ids.active)?.adjustments[0].note).toBe("SYN-private-adjustment");
});
it("filters before the 300-row bound; foreign volume cannot hide own cases or change own hasMore", async () => {
  const inserted = (await fx.pool.query("INSERT INTO patients(patient_number,full_name) SELECT 'SYN-OC-BULK-'||n,'SYN bulk '||n FROM generate_series(1,305) n RETURNING id")).rows.map(row => row.id);
  try {
    await fx.pool.query("INSERT INTO ortho_cases(patient_id,start_date,created_by) SELECT id,'2026-12-01','SYN' FROM patients WHERE id=ANY($1::int[])", [inserted]);
    expect(await read("own")).toMatchObject({ cases: [expect.objectContaining({ id: ids.active })], hasMore: false });
    const all = await read("all"); expect(all.cases).toHaveLength(300); expect(all.hasMore).toBe(true);
  } finally { await fx.pool.query("DELETE FROM ortho_cases WHERE patient_id=ANY($1::int[])", [inserted]); await fx.pool.query("DELETE FROM patients WHERE id=ANY($1::int[])", [inserted]); }
});
