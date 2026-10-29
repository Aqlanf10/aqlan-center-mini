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
  reception: { username: "SYN-P-RECEPTION", role: "reception", patientScope: "all", appointmentScope: "all", grants: { "appointments.create": true, "appointments.edit": true, "finance.patient-ledger.view": true } },
  clinicalAll: { username: "SYN-P-CLINICAL-ALL", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
  doctorA: { username: "SYN-P-DOCTOR-A", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  doctorB: { username: "SYN-P-DOCTOR-B", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.plans.view": true } },
  unlinked: { username: "SYN-P-UNLINKED", role: "doctor", patientScope: "own", grants: { "clinical.plans.view": true } },
  noScope: { username: "SYN-P-NOSCOPE", role: "doctor", doctor: true, patientScope: "none", grants: { "clinical.plans.view": true, "appointments.create": true } },
  adminLabel: { username: "SYN-P-ADMIN-LABEL", role: "admin", grants: { "clinical.plans.view": true, "finance.patient-ledger.view": true } },
  identity: { username: "SYN-P-IDENTITY", role: "reception", patientScope: "all" },
  finance: { username: "SYN-P-FINANCE", role: "accountant", patientScope: "all", grants: { "finance.patient-ledger.view": true } },
  creatorAll: { username: "SYN-P-CREATOR-ALL", role: "reception", patientScope: "all", grants: { "patients.create": true } },
  creatorOwn: { username: "SYN-P-CREATOR-OWN", role: "doctor", doctor: true, patientScope: "own", grants: { "patients.create": true } },
  opsReception: { username: "SYN-P-OPS-RECEPTION", role: "reception", patientScope: "all", appointmentScope: "all", grants: { "patients.operational-summary.view": true } },
  collector: { username: "SYN-P-COLLECTOR", role: "cashier", patientScope: "all", grants: { "finance.patient-ledger.view": true, "finance.payments.view": true, "finance.payments.collect": true } },
  doctorC: { username: "SYN-P-DOCTOR-C", role: "doctor", doctor: true, patientScope: "own", appointmentScope: "own", grants: { "clinical.plans.view": true } },
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
  it("scope all lists every patient; appointment grants give schedule context and never clinical fields", async () => {
    const found = await search("reception");
    expect(names(found.rows)).toEqual(["SYN Patient Alpha", "SYN Patient Beta", "SYN Patient Gamma"]);
    for (const row of found.rows) expect(row).not.toHaveProperty("medicalAlert");
    const page = await browse("reception");
    expect(page.total).toBe(3);
    expect(page.projection).toEqual({ care: false, operational: false, schedule: true, balances: true });
    const byName = Object.fromEntries(page.rows.map(row => [row.fullName, row]));
    expect(byName["SYN Patient Alpha"]).toHaveProperty("nextAppointment");
    for (const field of ["medicalAlert", "activeOrtho", "flags", "photoDocumentId"]) expect(byName["SYN Patient Alpha"]).not.toHaveProperty(field);
    expect(byName["SYN Patient Gamma"].balances).toEqual([{ currency: "YER", dueMinor: 5000 }]);
  });

  it("a clinical grant gives the clinical summary, without schedule or money", async () => {
    const page = await browse("clinicalAll");
    expect(page.projection).toEqual({ care: true, operational: true, schedule: false, balances: false });
    const alpha = page.rows.find(row => row.fullName === "SYN Patient Alpha")!;
    expect(alpha.medicalAlert).toContain("Synthetic penicillin allergy");
    for (const field of ["lastVisitAt", "nextAppointment", "balances"]) expect(alpha).not.toHaveProperty(field);
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

  it("the protected owner lists every patient with every column group", async () => {
    const page = await browse("owner");
    expect(page.total).toBe(3);
    expect(page.projection).toEqual({ care: true, operational: true, schedule: true, balances: true });
    expect(page.rows.find(row => row.fullName === "SYN Patient Alpha")!.medicalAlert).toContain("Synthetic penicillin allergy");
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
    expect(page.projection).toEqual({ care: false, operational: false, schedule: false, balances: false });
    for (const row of page.rows) expect(Object.keys(row).sort()).toEqual(["age", "fullName", "gender", "id", "patientNumber", "phone"]);
    for (const row of (await search("identity")).rows) expect(Object.keys(row).sort()).toEqual(["fullName", "id", "patientNumber", "phone"]);
  });

  it("filters and sorts on hidden groups refuse instead of leaking through selection", async () => {
    await expect(browse("identity", { filter: "debt" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { filter: "alert" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { filter: "ortho" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { sort: "last_visit" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { flag: "VIP" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("identity", { filter: "no_next" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("finance", { filter: "alert" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    // Appointment grants never open clinical filters; the schedule group opens its own.
    await expect(browse("reception", { filter: "alert" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("reception", { flag: "VIP" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
    await expect(browse("reception", { filter: "no_next" })).resolves.toMatchObject({ filter: "no_next" });
    await expect(browse("clinicalAll", { sort: "last_visit" })).rejects.toMatchObject({ code: "patient_filter_not_granted" });
  });

  it("patient ledger view: balances and the debt filter, never the medical alert", async () => {
    const page = await browse("finance", { filter: "debt" });
    expect(page.projection).toEqual({ care: false, operational: false, schedule: false, balances: true });
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

  it("losing the clinical grant removes the clinical summary at the next read", async () => {
    await fx.setGrants("clinicalAll", {}, { patientScope: "all" });
    const page = await browse("clinicalAll");
    expect(page.projection).toEqual({ care: false, operational: false, schedule: false, balances: false });
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

describe("one patient's file (read:patients.record)", () => {
  let epsilon = 0;
  beforeAll(async () => {
    // Added only now: the directory cases above count the first three patients.
    epsilon = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id,medical_alert,flags,note) VALUES('SYN-PA-5','SYN File Epsilon','0522222222',$1,'Synthetic latex allergy',ARRAY['VIP'],'Synthetic clinical note') RETURNING id", [fx.parties.doctorC!])).rows[0].id;
    await fx.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time) VALUES($1,$2,'2026-11-02','10:00'),($1,$3,'2026-11-03','11:00')", [epsilon, fx.parties.doctorC!, fx.parties.doctorA!]);
    await fx.pool.query("INSERT INTO visits(patient_name,patient_id,doctor_id) VALUES('SYN File Epsilon',$1,$2)", [epsilon, fx.parties.doctorC!]);
  });
  const file = async (k: Key, id = epsilon) => reads.readCanonicalPatientFile(await fx.session(k), id);

  it("own scope opens its clinician's patient: clinical fields, visits and only its own appointments", async () => {
    const view = await file("doctorC");
    expect(view.patient).toMatchObject({ fullName: "SYN File Epsilon", medicalAlert: "Synthetic latex allergy", flags: ["VIP"], note: "Synthetic clinical note" });
    expect(view.visits).toHaveLength(1);
    expect(view.appointments!.map(a => a.scheduledDate)).toEqual(["2026-11-02"]);
    expect(view.projection).toMatchObject({ care: true, appointments: "own" });
  });

  it("outside the scope and missing read the same: patient_not_found, no existence leak", async () => {
    const outside = await file("doctorB").catch(error => error);
    const missing = await file("doctorC", 999_999).catch(error => error);
    expect(outside).toMatchObject({ code: "patient_not_found" });
    expect(missing).toMatchObject({ code: "patient_not_found", message: outside.message });
    await expect(file("doctorC", 0)).rejects.toMatchObject({ code: "invalid_patient_query" });
  });

  it("appointment grants and an all appointment scope never reveal clinical fields or visits", async () => {
    const view = await file("reception");
    for (const field of ["medicalAlert", "flags", "note", "referralSource", "referredBy"]) expect(view.patient).not.toHaveProperty(field);
    expect(view).not.toHaveProperty("visits");
    expect(view.appointments).toHaveLength(2);
  });

  it("no appointment scope: no appointments key at all", async () => {
    await fx.setGrants("clinicalAll", { "clinical.plans.view": true }, { patientScope: "all" });
    const view = await file("clinicalAll");
    expect(view).not.toHaveProperty("appointments");
    expect(view.patient.medicalAlert).toBe("Synthetic latex allergy");
    expect(view.projection.appointments).toBe("none");
  });

  it("scope none and stale sessions refuse; the owner reads everything", async () => {
    await expect(file("noScope")).rejects.toThrow("STAFF_OPERATION_RECORD_SCOPE_DENIED");
    const before = await fx.session("doctorC");
    await fx.setGrants("doctorC", { "clinical.plans.view": true }, { patientScope: "own", appointmentScope: "none" });
    await expect(reads.readCanonicalPatientFile(before, epsilon)).rejects.toThrow(/^STAFF_OPERATION_(PERMISSIONS|CREDENTIAL_OR_ACCOUNT)_STALE$/);
    expect(await file("doctorC")).not.toHaveProperty("appointments");
    const owner = await file("owner");
    expect(owner).toMatchObject({ projection: { care: true, schedule: true, balances: true, appointments: "all" } });
    expect(owner.appointments).toHaveLength(2);
  });
});


describe("clinical sub-reads and the timeline (slice 3)", () => {
  let zeta = 0;
  beforeAll(async () => {
    zeta = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PA-6','SYN File Zeta','0533333333',$1) RETURNING id", [fx.parties.doctorA!])).rows[0].id;
    await fx.pool.query(`INSERT INTO patient_medical_history(patient_id,allergies,asa_class,recorded_by) VALUES($1,'[{"substance":"Synthetic penicillin","reaction":null,"severity":"severe"}]'::jsonb,'II','synthetic')`, [zeta]);
    await fx.pool.query("INSERT INTO patient_vitals(patient_id,bp_systolic,bp_diastolic,pulse,recorded_by) VALUES($1,120,80,72,'synthetic')", [zeta]);
    await fx.pool.query("INSERT INTO patient_problems(patient_id,label,noted_by) VALUES($1,'Synthetic crowding','synthetic')", [zeta]);
    await fx.pool.query("INSERT INTO lab_orders(patient_id,lab_name,work_type,due_date) VALUES($1,'Synthetic lab','Synthetic retainer','2026-11-10')", [zeta]);
    await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYN-PA-ZETA',$1,7000,0,'YER','open','synthetic')", [zeta]);
    await fx.pool.query("INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time) VALUES($1,$2,'2026-10-01','09:00')", [zeta, fx.parties.doctorA!]);
  });
  const kinds = async (k: Key) => [...new Set((await reads.readCanonicalTimeline(await fx.session(k), zeta, 60)).events.map(event => event.kind))].sort();

  it("a clinical grant inside the scope reads medical history (with derived alerts), vitals and problems", async () => {
    const history = await reads.readCanonicalMedicalHistory(await fx.session("doctorA"), zeta);
    expect(history.alerts.map(alert => alert.label)).toEqual(["حساسية Synthetic penicillin (شديدة)"]);
    expect(history.vitals[0]).toMatchObject({ bpSystolic: 120, bpDiastolic: 80, pulse: 72 });
    expect(history.review).toMatchObject({ due: false });
    expect((await reads.readCanonicalVitals(await fx.session("doctorA"), zeta)).vitals).toHaveLength(1);
    expect((await reads.readCanonicalProblems(await fx.session("doctorA"), zeta)).map(problem => problem.label)).toEqual(["Synthetic crowding"]);
  });

  it("no clinical grant refuses at admission, before the patient is looked up", async () => {
    for (const read of [reads.readCanonicalMedicalHistory, reads.readCanonicalVitals, reads.readCanonicalProblems]) {
      await expect(read(await fx.session("reception"), zeta)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
      await expect(read(await fx.session("reception"), 999_999)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    }
  });

  it("a clinical grant outside the scope reads like a missing patient", async () => {
    await expect(reads.readCanonicalMedicalHistory(await fx.session("doctorB"), zeta)).rejects.toMatchObject({ code: "patient_not_found" });
  });

  it("timeline events of hidden groups are omitted entirely, never masked", async () => {
    expect(await kinds("owner")).toEqual(["appointment", "invoice", "lab"]);
    expect(await kinds("reception")).toEqual(["appointment", "invoice"]); // schedule + balances, no clinical
    expect(await kinds("clinicalAll")).toEqual(["lab"]); // care only
    expect(await kinds("finance")).toEqual(["invoice"]); // balances only
    expect(await kinds("identity")).toEqual([]);
    const ownerInvoice = (await reads.readCanonicalTimeline(await fx.session("owner"), zeta, 60)).events.find(event => event.kind === "invoice")!;
    expect(ownerInvoice.amountMinor).toBe(7000);
  });
});

describe("more patient file reads (slice 4)", () => {
  const REFERRAL_SPECIALTY = "oral_surgery";
  let eta = 0;
  beforeAll(async () => {
    eta = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PA-7','SYN File Eta','0544444444',$1) RETURNING id", [fx.parties.doctorA!])).rows[0].id;
    await fx.pool.query(`INSERT INTO patient_diagnoses(patient_id,content,created_by) VALUES($1,'{"summary":"Synthetic class II"}'::jsonb,'synthetic')`, [eta]);
    await fx.pool.query("INSERT INTO patient_referrals(patient_id,to_name,to_specialty,reason,created_by) VALUES($1,'Synthetic surgeon',$2,'Synthetic impacted canine','synthetic')", [eta, REFERRAL_SPECIALTY]);
    await fx.pool.query("INSERT INTO patient_contact_consents(patient_id,channel,granted,source,recorded_by) VALUES($1,'whatsapp',TRUE,'in_person','synthetic')", [eta]);
  });

  it("clinical reads: diagnoses, intake history and referrals for a clinical grant inside the scope", async () => {
    const session = await fx.session("doctorA");
    expect((await reads.readCanonicalDiagnoses(session, eta, null)).diagnoses.map(d => d.content)).toEqual([{ summary: "Synthetic class II" }]);
    expect((await reads.readCanonicalIntakeHistory(await fx.session("doctorA"), eta)).forms).toEqual([]);
    expect((await reads.readCanonicalReferrals(await fx.session("doctorA"), eta)).map(r => r.toName)).toEqual(["Synthetic surgeon"]);
  });

  it("clinical reads refuse without a clinical grant, and outside the scope read like missing", async () => {
    await expect(reads.readCanonicalDiagnoses(await fx.session("reception"), eta, null)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
    await expect(reads.readCanonicalReferrals(await fx.session("doctorB"), eta)).rejects.toMatchObject({ code: "patient_not_found" });
  });

  it("contact consents: any admitted actor reads them; recording follows patients.edit, never a role label", async () => {
    const reception = await reads.readCanonicalContactConsents(await fx.session("reception"), eta);
    expect(reception.states).toMatchObject({ whatsapp: "granted" });
    expect(reception.canRecord).toBe(false); // reception label, no patients.edit
    expect((await reads.readCanonicalContactConsents(await fx.session("owner"), eta)).canRecord).toBe(true);
    await expect(reads.readCanonicalContactConsents(await fx.session("doctorB"), eta)).rejects.toMatchObject({ code: "patient_not_found" });
  });
});

describe("arrival panel (slice 5)", () => {
  let iota = 0;
  beforeAll(async () => {
    iota = (await fx.pool.query<{ id: number }>("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES('SYN-PA-8','SYN File Iota','0555555555',$1) RETURNING id", [fx.parties.doctorA!])).rows[0].id;
    const today = "(now() AT TIME ZONE 'Asia/Aden')::date";
    await fx.pool.query(`INSERT INTO appointments(patient_id,doctor_id,scheduled_date,scheduled_time) VALUES($1,$2,${today},'10:00'),($1,$3,${today},'12:00')`, [iota, fx.parties.doctorA!, fx.parties.doctorB!]);
    await fx.pool.query("INSERT INTO invoices(invoice_number,patient_id,total_minor,discount_minor,base_currency,status,created_by) VALUES('SYN-PA-IOTA',$1,9000,0,'YER','open','synthetic')", [iota]);
  });
  const panel = async (k: Key) => reads.readCanonicalArrivalPanel(await fx.session(k), iota);

  it("reception context: today's appointments and money, no clinical keys, no collection without the grant", async () => {
    const view = await panel("reception");
    expect(view.appointments!.map(a => a.time)).toEqual(["10:00", "12:00"]);
    expect(view.money!.lines.find(line => line.currency === "YER")).toBeTruthy();
    expect(view).not.toHaveProperty("cases");
    expect(view).not.toHaveProperty("ortho");
    expect(view.canCollect).toBe(false);
  });

  it("collection is offered only with the ledger AND finance.payments.collect; no appointment scope removes the key", async () => {
    const view = await panel("collector");
    expect(view.canCollect).toBe(true);
    expect(view).not.toHaveProperty("appointments");
    expect(view).not.toHaveProperty("cases");
  });

  it("a clinical actor gets cases and ortho but no money; the owner gets everything", async () => {
    const clinical = await panel("clinicalAll");
    expect(clinical).toHaveProperty("cases");
    expect(clinical).toHaveProperty("ortho");
    expect(clinical).not.toHaveProperty("money");
    expect(clinical.canCollect).toBe(false);
    const owner = await panel("owner");
    expect(owner.appointments).toHaveLength(2);
    expect(owner).toHaveProperty("money");
    expect(owner.canCollect).toBe(true);
  });

  it("outside the scope or missing reads the same; identity-only sees the visit state only", async () => {
    // doctorB has an appointment with this patient, so the patient IS inside doctorB's
    // own scope (the shared predicate counts appointments); creatorOwn has no link to it.
    expect((await panel("doctorB")).patientName).toBe("SYN File Iota");
    await expect(panel("creatorOwn")).rejects.toMatchObject({ code: "patient_not_found" });
    const identity = await panel("identity");
    expect(Object.keys(identity).sort()).toEqual(["activeVisit", "canCollect", "patientId", "patientName", "projection", "today"]);
  });
});


describe("every canonical read stays inside its one owning snapshot", () => {
  it("each reader takes exactly one pool lease and never queries the pool directly", async () => {
    const { rows: [any] } = await fx.pool.query<{ id: number }>("SELECT id FROM patients WHERE patient_number='SYN-PA-8'");
    const pool = db.getPool();
    const readers: [string, (session: Awaited<ReturnType<typeof fx.session>>) => Promise<unknown>][] = [
      ["search", s => reads.readCanonicalPatientSearch(s, { kind: "search", term: "SYN" })],
      ["browse", s => reads.readCanonicalPatientBrowse(s, { kind: "browse", page: 0, filter: "all", sort: "name", flag: null, today: TODAY })],
      ["browse debt", s => reads.readCanonicalPatientBrowse(s, { kind: "browse", page: 0, filter: "debt", sort: "name", flag: null, today: TODAY })],
      ["file", s => reads.readCanonicalPatientFile(s, any.id)],
      ["medical history", s => reads.readCanonicalMedicalHistory(s, any.id)],
      ["vitals", s => reads.readCanonicalVitals(s, any.id)],
      ["problems", s => reads.readCanonicalProblems(s, any.id)],
      ["timeline", s => reads.readCanonicalTimeline(s, any.id, 60)],
      ["diagnoses", s => reads.readCanonicalDiagnoses(s, any.id, null)],
      ["intake history", s => reads.readCanonicalIntakeHistory(s, any.id)],
      ["referrals", s => reads.readCanonicalReferrals(s, any.id)],
      ["contact", s => reads.readCanonicalContactConsents(s, any.id)],
      ["arrival panel", s => reads.readCanonicalArrivalPanel(s, any.id)],
      ["workflow", s => reads.readCanonicalPatientWorkflow(s, any.id)],
    ];
    for (const [name, read] of readers) {
      const session = await fx.session("owner");
      const connect = vi.spyOn(pool, "connect");
      const query = vi.spyOn(pool, "query");
      try {
        await read(session);
        expect({ name, connects: connect.mock.calls.length, directQueries: query.mock.calls.length }).toEqual({ name, connects: 1, directQueries: 0 });
      } finally { connect.mockRestore(); query.mockRestore(); }
    }
  });
});

describe("patient workflow summary (slice 6)", () => {
  const iota = async () => (await fx.pool.query<{ id: number }>("SELECT id FROM patients WHERE patient_number='SYN-PA-8'")).rows[0].id;
  const workflow = async (k: Key) => reads.readCanonicalPatientWorkflow(await fx.session(k), await iota());

  it("identity-only: basic fields and the open visit, no clinical, schedule or money keys", async () => {
    const view = await workflow("identity");
    expect(view.patient).not.toHaveProperty("medicalAlert");
    for (const key of ["nextAppointment", "lastVisit", "activePlans", "plannedVisits", "counts", "assessmentCases", "legacyCases", "alerts", "financial"]) {
      expect(view).not.toHaveProperty(key);
    }
    expect(view.canSeeFinancial).toBe(false);
  });

  it("reception (schedule + balances): next appointment and money, never clinical fields", async () => {
    const view = await workflow("reception");
    expect(view).toHaveProperty("nextAppointment");
    expect(view).toHaveProperty("financial");
    expect(view).not.toHaveProperty("lastVisit");
    expect(view.patient).not.toHaveProperty("medicalAlert");
    for (const alert of view.alerts ?? []) expect(alert.kind).toBe("overdue_installment");
  });

  it("clinical-only: plans without money fields, planned visits never rebookable yet", async () => {
    const view = await workflow("clinicalAll");
    expect(view).toHaveProperty("lastVisit");
    expect(view).not.toHaveProperty("financial");
    for (const plan of view.activePlans ?? []) for (const key of ["totalMinor", "remainingMinor", "overdueMinor"]) expect(plan).not.toHaveProperty(key);
    for (const visit of view.plannedVisits ?? []) expect(visit.canRebook).toBe(false);
  });

  it("outside the scope reads like missing; the owner gets every group", async () => {
    await expect(workflow("creatorOwn")).rejects.toMatchObject({ code: "patient_not_found" });
    const owner = await workflow("owner");
    for (const key of ["nextAppointment", "lastVisit", "activePlans", "financial", "alerts"]) expect(owner).toHaveProperty(key);
    expect(owner.canSeeFinancial).toBe(true);
  });
});

describe("reception operational summary (owner decision 1, Dot 6484846432)", () => {
  const ALERT_TEXT_FRAGMENTS = ["penicillin", "latex", "Synthetic penicillin allergy", "Synthetic latex allergy", "حساسية"];
  const idOf = async (number: string) => (await fx.pool.query<{ id: number }>("SELECT id FROM patients WHERE patient_number=$1", [number])).rows[0].id;
  const noAlertText = (value: unknown) => { const json = JSON.stringify(value); for (const fragment of ALERT_TEXT_FRAGMENTS) expect(json).not.toContain(fragment); };

  it("list and search: alert existence, active orthodontics and flags only — never the alert text", async () => {
    const page = await reads.readCanonicalPatientBrowse(await fx.session("opsReception"), { kind: "browse", page: 0, filter: "all", sort: "name", flag: null, today: TODAY });
    expect(page.projection).toMatchObject({ care: false, operational: true });
    const alpha = page.rows.find(row => row.fullName === "SYN Patient Alpha")!;
    expect(alpha).toMatchObject({ hasMedicalAlert: true });
    expect(alpha).toHaveProperty("activeOrtho");
    expect(alpha).toHaveProperty("flags");
    expect(alpha).not.toHaveProperty("medicalAlert");
    noAlertText(page);
    const found = await reads.readCanonicalPatientSearch(await fx.session("opsReception"), { kind: "search", term: "SYN Patient" });
    expect(found.rows.find(row => row.fullName === "SYN Patient Alpha")).toMatchObject({ hasMedicalAlert: true });
    noAlertText(found);
  });

  it("search never matches on the alert text, for anyone", async () => {
    for (const k of ["opsReception", "owner"] as const) {
      expect((await reads.readCanonicalPatientSearch(await fx.session(k), { kind: "search", term: "penicillin" })).rows).toEqual([]);
    }
  });

  it("existence filters are allowed and reveal nothing beyond existence; derived history alerts count too", async () => {
    const alerted = await reads.readCanonicalPatientBrowse(await fx.session("opsReception"), { kind: "browse", page: 0, filter: "alert", sort: "name", flag: null, today: TODAY });
    expect(alerted.rows.map(row => row.fullName)).toEqual(expect.arrayContaining(["SYN Patient Alpha", "SYN File Zeta"]));
    for (const row of alerted.rows) expect(row).toMatchObject({ hasMedicalAlert: true });
    noAlertText(alerted);
    // Zeta's alert comes only from its medical history: the file says so too, without text.
    const zeta = await reads.readCanonicalPatientFile(await fx.session("opsReception"), await idOf("SYN-PA-6"));
    expect(zeta.patient).toMatchObject({ hasMedicalAlert: true });
  });

  it("file, workflow, arrival panel and timeline: no diagnoses, notes, history, plans or clinical events", async () => {
    const epsilon = await idOf("SYN-PA-5");
    const file = await reads.readCanonicalPatientFile(await fx.session("opsReception"), epsilon);
    expect(file.patient).toMatchObject({ hasMedicalAlert: true, flags: ["VIP"] });
    for (const key of ["medicalAlert", "note", "referralSource", "referredBy"]) expect(file.patient).not.toHaveProperty(key);
    expect(file).not.toHaveProperty("visits");
    noAlertText(file);
    const workflow = await reads.readCanonicalPatientWorkflow(await fx.session("opsReception"), epsilon);
    expect(workflow.patient).toMatchObject({ hasMedicalAlert: true });
    for (const key of ["lastVisit", "activePlans", "plannedVisits", "counts", "assessmentCases", "legacyCases"]) expect(workflow).not.toHaveProperty(key);
    noAlertText(workflow);
    const arrival = await reads.readCanonicalArrivalPanel(await fx.session("opsReception"), epsilon);
    expect(arrival).toMatchObject({ hasMedicalAlert: true });
    expect(arrival).toHaveProperty("activeOrtho");
    expect(arrival).not.toHaveProperty("cases");
    expect(arrival).not.toHaveProperty("ortho");
    const timeline = await reads.readCanonicalTimeline(await fx.session("opsReception"), await idOf("SYN-PA-6"), 60);
    expect(timeline.events.every(event => ["appointment"].includes(event.kind))).toBe(true);
    await expect(reads.readCanonicalMedicalHistory(await fx.session("opsReception"), epsilon)).rejects.toThrow("STAFF_OPERATION_CAPABILITY_DENIED");
  });

  it("revoking the summary grant removes it at the next read", async () => {
    await fx.setGrants("opsReception", {}, { patientScope: "all", appointmentScope: "all" });
    const page = await reads.readCanonicalPatientBrowse(await fx.session("opsReception"), { kind: "browse", page: 0, filter: "all", sort: "name", flag: null, today: TODAY });
    expect(page.projection.operational).toBe(false);
    for (const row of page.rows) for (const key of ["hasMedicalAlert", "activeOrtho", "flags"]) expect(row).not.toHaveProperty(key);
    await expect(reads.readCanonicalPatientBrowse(await fx.session("opsReception"), { kind: "browse", page: 0, filter: "alert", sort: "name", flag: null, today: TODAY }))
      .rejects.toMatchObject({ code: "patient_filter_not_granted" });
  });
});

