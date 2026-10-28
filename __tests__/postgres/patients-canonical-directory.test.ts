/** M2 slices 1 and 1b: canonical patient directory (GET /api/patients) and creation
 * (POST /api/patients) on real PostgreSQL,
 * synthetic data only. One owning RR READ ONLY snapshot admitted by the registered
 * record read `read:patients.directory`: the patient scope filters rows (`own` = the
 * validated clinician link), current grants decide the projected column groups, and a
 * role label never widens anything. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-patients-secret-2026");
const db = await import("../../lib/db");
const reads = await import("../../lib/canonical-patient-reads");
const { CANONICAL_RECORD_READS } = await import("../../lib/canonical-record-reads");
const writes = await import("../../lib/canonical-patient-writes");
/** The patient import's exclusive lock (lib/db.ts PATIENT_IMPORT_EXCLUSIVE_LOCK_SQL, not exported). */
const PATIENT_IMPORT_EXCLUSIVE_LOCK_FOR_TESTS = "SELECT pg_advisory_xact_lock(hashtext('patient_import'))";

const ACCOUNTS = {
  owner: { username: "SYN-P-OWNER", role: "admin" },
  reception: { username: "SYN-P-RECEPTION", role: "reception", patientScope: "all", grants: { "appointments.create": true, "finance.patient-ledger.view": true } },
  doctorA: { username: "SYN-P-DOCTOR-A", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  doctorB: { username: "SYN-P-DOCTOR-B", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  unlinked: { username: "SYN-P-UNLINKED", role: "doctor", patientScope: "own", grants: { "clinical.plans.view": true } },
  noScope: { username: "SYN-P-NOSCOPE", role: "doctor", doctor: true, patientScope: "none", grants: { "clinical.plans.view": true, "appointments.create": true } },
  adminLabel: { username: "SYN-P-ADMIN-LABEL", role: "admin", grants: { "clinical.plans.view": true, "finance.patient-ledger.view": true } },
  identity: { username: "SYN-P-IDENTITY", role: "reception", patientScope: "all" },
  finance: { username: "SYN-P-FINANCE", role: "accountant", patientScope: "all", grants: { "finance.patient-ledger.view": true } },
  creatorAll: { username: "SYN-P-CREATOR-ALL", role: "reception", patientScope: "all", grants: { "patients.create": true } },
  creatorOwn: { username: "SYN-P-CREATOR-OWN", role: "doctor", doctor: true, patientScope: "own", grants: { "patients.create": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const ids: Record<"alpha" | "beta" | "gamma", number> = { alpha: 0, beta: 0, gamma: 0 };
const TODAY = "2026-10-28";
const search = async (k: Key, term = "SYN Patient") => reads.readCanonicalPatientSearch(await fx.session(k), { kind: "search", term });
const browse = async (k: Key, over: Partial<Parameters<typeof reads.readCanonicalPatientBrowse>[1]> = {}) =>
  reads.readCanonicalPatientBrowse(await fx.session(k), { kind: "browse", page: 0, filter: "all", sort: "name", flag: null, today: TODAY, ...over });
const names = (rows: readonly { fullName: string }[]) => rows.map(row => row.fullName).sort();

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const insert = async (number: string, name: string, doctor: number | null, alert: string | null) =>
    (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert) VALUES($1,$2,'0500000000',$3,$4) RETURNING id", [number, name, doctor, alert])).rows[0].id;
  ids.alpha = await insert("SYN-PA-1", "SYN Patient Alpha", fx.parties.doctorA!, "Synthetic penicillin allergy");
  ids.beta = await insert("SYN-PA-2", "SYN Patient Beta", fx.parties.doctorB!, null);
  ids.gamma = await insert("SYN-PA-3", "SYN Patient Gamma", null, null);
  await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYN-PA-INV',$1,5000,0,'YER','open','synthetic')", [ids.gamma]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("registered record read", () => {
  it("is a closed, prefixed registry entry for the patient record scope", () => {
    expect(CANONICAL_RECORD_READS["read:patients.directory"]).toEqual({ record: "patient", need: [], anyOf: [] });
  });
});

describe("patient scope filters rows", () => {
  it("scope all lists every patient, with the care summary and balances its grants hold", async () => {
    const found = await search("reception");
    expect(names(found.rows)).toEqual(["SYN Patient Alpha", "SYN Patient Beta", "SYN Patient Gamma"]);
    const page = await browse("reception");
    expect(page.total).toBe(3);
    expect(page.projection).toEqual({ care: true, balances: true });
    const byName = Object.fromEntries(page.rows.map(row => [row.fullName, row]));
    expect(byName["SYN Patient Alpha"].medicalAlert).toContain("Synthetic penicillin allergy");
    expect(byName["SYN Patient Gamma"].balances).toEqual([{ currency: "YER", dueMinor: 5000 }]);
    expect(byName["SYN Patient Alpha"]).not.toHaveProperty("photoDocumentId");
  });

  it("scope own lists only the validated clinician's patients, for search and browse alike", async () => {
    expect(names((await search("doctorA")).rows)).toEqual(["SYN Patient Alpha"]);
    expect(names((await search("doctorB")).rows)).toEqual(["SYN Patient Beta"]);
    const page = await browse("doctorA");
    expect(page.total).toBe(1);
    expect(names(page.rows)).toEqual(["SYN Patient Alpha"]);
    // Another doctor's patient is not reachable by its exact file number either.
    expect((await search("doctorA", "SYN-PA-2")).rows).toEqual([]);
  });

  it("the protected owner lists every patient", async () => {
    expect((await browse("owner")).total).toBe(3);
  });

  it("scope none refuses before any row is read, whatever the grants", async () => {
    await expect(search("noScope")).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    await expect(browse("noScope")).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  });

  it("scope own without a validated clinician link is no scope", async () => {
    await expect(search("unlinked")).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  });

  it("an admin role label never widens the scope", async () => {
    await expect(browse("adminLabel")).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
  });
});

describe("grant projection", () => {
  it("identity only: no clinical or money field is published", async () => {
    const page = await browse("identity");
    expect(page.projection).toEqual({ care: false, balances: false });
    for (const row of page.rows) expect(Object.keys(row).sort()).toEqual(["fullName", "id", "patientNumber", "phone"]);
    for (const row of (await search("identity")).rows) expect(Object.keys(row).sort()).toEqual(["fullName", "id", "patientNumber", "phone"]);
  });

  it("filters and sorts on hidden groups refuse instead of leaking through selection", async () => {
    await expect(browse("identity", { filter: "debt" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { filter: "alert" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { filter: "ortho" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { sort: "last_visit" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { flag: "VIP" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("finance", { filter: "alert" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
  });

  it("patient ledger view: balances and the debt filter, never the medical alert", async () => {
    const page = await browse("finance", { filter: "debt" });
    expect(page.projection).toEqual({ care: false, balances: true });
    expect(page.rows.map(row => [row.fullName, row.balances])).toEqual([["SYN Patient Gamma", [{ currency: "YER", dueMinor: 5000 }]]]);
    for (const row of (await browse("finance")).rows) expect(row).not.toHaveProperty("medicalAlert");
  });

  it("an invalid page is a bounded refusal", async () => {
    await expect(browse("reception", { page: -1 })).rejects.toMatchObject({ code: "invalid_patient_query" });
    await expect(browse("reception", { today: "28/10/2026" })).rejects.toMatchObject({ code: "invalid_patient_query" });
  });
});

describe("revocation", () => {
  it("a scope change makes the old session stale, and the new session gets no rows", async () => {
    const before = await fx.session("doctorB");
    await fx.setGrants("doctorB", { "clinical.plans.view": true }, { patientScope: "none" });
    await expect(reads.readCanonicalPatientSearch(before, { kind: "search", term: "SYN" })).rejects.toThrow(/^STAFF_OPERATION_(PERMISSIONS|CREDENTIAL_OR_ACCOUNT)_STALE$/);
    await expect(search("doctorB")).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    await fx.setGrants("doctorB", { "clinical.plans.view": true }, { patientScope: "own" });
    expect(names((await search("doctorB")).rows)).toEqual(["SYN Patient Beta"]);
  });

  it("losing the care grant removes the care summary at the next read", async () => {
    await fx.setGrants("reception", { "finance.patient-ledger.view": true }, { patientScope: "all" });
    const page = await browse("reception");
    expect(page.projection).toEqual({ care: false, balances: true });
    for (const row of page.rows) expect(row).not.toHaveProperty("medicalAlert");
  });
});

describe("canonical creation (patients.create)", () => {
  const input = (fullName: string, phone: string | null = null) => ({
    fullName, phone, altPhone: null, gender: "unknown" as const, birthYear: null, address: null, medicalAlert: null, note: null,
  });
  const count = async (name: string) => (await fx.pool.query<{ n: number }>("SELECT count(*)::int AS n FROM patients WHERE full_name=$1", [name])).rows[0].n;
  const audits = async (name: string) => (await fx.pool.query<{ actor: string; actor_role: string }>("SELECT actor, actor_role FROM audit_log WHERE action='patient.create' AND summary LIKE '%' || $1 || '%' ORDER BY id", [name])).rows;

  it("an adjacent grant never creates; nothing is written", async () => {
    await expect(writes.commandCanonicalPatientCreate(await fx.session("reception"), input("SYN Denied Create"), false)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(writes.commandCanonicalPatientCreate(await fx.session("adminLabel"), input("SYN Denied Create"), false)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect(await count("SYN Denied Create")).toBe(0);
  });

  it("creates the patient and its audit row in one transaction, attributed to the admitted actor", async () => {
    const result = await writes.commandCanonicalPatientCreate(await fx.session("creatorAll"), input("SYN Created Delta", "0511111111"), false);
    expect(result).toMatchObject({ kind: "created", patient: { fullName: "SYN Created Delta" } });
    expect(await count("SYN Created Delta")).toBe(1);
    expect(await audits("SYN Created Delta")).toEqual([{ actor: ACCOUNTS.creatorAll.username, actor_role: "reception" }]);
  });

  it("duplicate candidates are disclosed only to an all-patient scope; confirming still creates", async () => {
    const all = await writes.commandCanonicalPatientCreate(await fx.session("creatorAll"), input("SYN Created Delta Copy", "0511111111"), false);
    expect(all).toMatchObject({ kind: "duplicates", disclosed: true });
    expect(all.kind === "duplicates" && all.duplicates.map(match => match.patient.fullName)).toEqual(["SYN Created Delta"]);
    const own = await writes.commandCanonicalPatientCreate(await fx.session("creatorOwn"), input("SYN Created Delta Copy", "0511111111"), false);
    expect(own).toEqual({ kind: "duplicates", message: expect.stringMatching(/[؀-ۿ]/), duplicates: [], disclosed: false });
    expect(await count("SYN Created Delta Copy")).toBe(0);
    const confirmed = await writes.commandCanonicalPatientCreate(await fx.session("creatorOwn"), input("SYN Created Delta Copy", "0511111111"), true);
    expect(confirmed.kind).toBe("created");
    expect(await count("SYN Created Delta Copy")).toBe(1);
  });

  it("an audit failure rolls the patient back (no silent create)", async () => {
    await fx.pool.query(`CREATE FUNCTION synthetic_refuse_patient_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action='patient.create' AND NEW.summary LIKE '%SYN Audit Refused%' THEN RAISE EXCEPTION 'synthetic audit refusal'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER synthetic_refuse_patient_audit BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION synthetic_refuse_patient_audit();`);
    try {
      await expect(writes.commandCanonicalPatientCreate(await fx.session("creatorAll"), input("SYN Audit Refused"), false)).rejects.toThrow();
      expect(await count("SYN Audit Refused")).toBe(0);
    } finally {
      await fx.pool.query("DROP TRIGGER synthetic_refuse_patient_audit ON audit_log; DROP FUNCTION synthetic_refuse_patient_audit()");
    }
  });

  it("a running patient import is never interleaved: creation waits for its exclusive lock", async () => {
    // A dedicated connection: the fixture pool has one connection, used by the checks below.
    const session = await fx.session("creatorAll");
    const importer = new Client({ connectionString: fx.pool.options.connectionString });
    await importer.connect();
    let open = false;
    try {
      await importer.query("BEGIN");
      open = true;
      await importer.query(PATIENT_IMPORT_EXCLUSIVE_LOCK_FOR_TESTS);
      let settled = false;
      const pending = writes.commandCanonicalPatientCreate(session, input("SYN During Import"), true).finally(() => { settled = true; });
      await new Promise(resolve => setTimeout(resolve, 400));
      expect(settled).toBe(false);
      expect(await count("SYN During Import")).toBe(0);
      await importer.query("COMMIT");
      open = false;
      await expect(pending).resolves.toMatchObject({ kind: "created" });
      expect(await count("SYN During Import")).toBe(1);
    } finally {
      if (open) await importer.query("ROLLBACK").catch(() => {});
      await importer.end();
    }
  });

  it("revoking patients.create makes the old session stale and the new one refused", async () => {
    const before = await fx.session("creatorOwn");
    await fx.setGrants("creatorOwn", {}, { patientScope: "own" });
    await expect(writes.commandCanonicalPatientCreate(before, input("SYN After Revoke"), true)).rejects.toThrow(/^STAFF_OPERATION_(PERMISSIONS|CREDENTIAL_OR_ACCOUNT)_STALE$/);
    await expect(writes.commandCanonicalPatientCreate(await fx.session("creatorOwn"), input("SYN After Revoke"), true)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    expect(await count("SYN After Revoke")).toBe(0);
  });
});
