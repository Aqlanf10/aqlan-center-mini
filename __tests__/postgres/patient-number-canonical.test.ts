/** M2 slice 78: the canonical patient file number on real PostgreSQL, synthetic data only.
 * patients.number.manage inside the patient scope; the legacy body (stale/same refusals,
 * update and audit together, the old number retired); outside answers like missing;
 * concurrent changes of one file serialize; revocation refuses an earlier session. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-patient-number-secret-2026");
const db = await import("../../lib/db");
const numbers = await import("../../lib/canonical-patient-number");

const MANAGE = { "patients.edit": true, "patients.number.manage": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-PN-OWNER", role: "admin" },
  clerk: { username: "SYN-PN-CLERK", role: "reception", patientScope: "all", grants: { ...MANAGE } },
  doctor: { username: "SYN-PN-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { ...MANAGE } },
  editor: { username: "SYN-PN-EDIT", role: "reception", patientScope: "all", grants: { "patients.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const ids = { mine: 0, other: 0 };

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000951',$3) RETURNING id", [number, `SYN PN ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("P-90001", fx.parties.doctor!);
  ids.other = await patient("P-90002", null);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("number", () => {
  it("reads and changes the number with its audit; the old number is retired; stale and same are refused", async () => {
    const before = await numbers.readCanonicalPatientNumber(await fx.session("clerk"), String(ids.mine));
    expect(before).toMatchObject({ patientId: ids.mine, patientNumber: "P-90001" });
    const after = await numbers.commandCanonicalPatientNumber(await fx.session("clerk"), String(ids.mine), {
      patientNumber: "90011", expectedPatientNumber: "P-90001", expectedVersion: before.version, reason: "تصحيح اصطناعي",
    });
    expect(after).toMatchObject({ patientId: ids.mine, patientNumber: "P-90011" });
    expect(BigInt(after.version)).toBe(BigInt(before.version) + 1n);
    expect((await q("SELECT actor FROM audit_log WHERE action='patient.number.change' AND entity_id=$1::text", [ids.mine])).map(row => row.actor)).toEqual(["SYN-PN-CLERK"]);
    expect((await q("SELECT count(*)::int AS n FROM retired_patient_numbers WHERE patient_number='P-90001'"))[0].n).toBe(1);
    expect(await refusal(numbers.commandCanonicalPatientNumber(await fx.session("clerk"), String(ids.mine), {
      patientNumber: "90012", expectedPatientNumber: "P-90001", expectedVersion: before.version, reason: "قديم",
    }))).toMatchObject({ code: "stale" });
    expect(await refusal(numbers.commandCanonicalPatientNumber(await fx.session("clerk"), String(ids.mine), {
      patientNumber: "90011", expectedPatientNumber: "P-90011", expectedVersion: after.version, reason: "مطابق",
    }))).toMatchObject({ code: "invalid" });
    expect(await refusal(numbers.commandCanonicalPatientNumber(await fx.session("clerk"), String(ids.other), {
      patientNumber: "90001", expectedPatientNumber: "P-90002", expectedVersion: "1", reason: "رقم متقاعد",
    }))).toMatchObject({ code: "duplicate" });
    expect((await q("SELECT patient_number FROM patients WHERE id=$1", [ids.other]))[0].patient_number).toBe("P-90002");
  });

  it("two concurrent changes of one file: exactly one wins, the other is stale", async () => {
    const current = await numbers.readCanonicalPatientNumber(await fx.session("owner"), String(ids.mine));
    const change = async (number: string) => numbers.commandCanonicalPatientNumber(await fx.session("owner"), String(ids.mine), {
      patientNumber: number, expectedPatientNumber: current.patientNumber, expectedVersion: current.version, reason: "تزامن اصطناعي",
    }).then(() => "ok", (error: { code?: string }) => error.code);
    expect((await Promise.all([change("90021"), change("90022")])).sort()).toEqual(["ok", "stale"]);
  });

  it("refuses without the grant and outside the scope, writing nothing", async () => {
    await expect(numbers.readCanonicalPatientNumber(await fx.session("editor"), String(ids.mine))).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(numbers.readCanonicalPatientNumber(await fx.session("doctor"), String(ids.other)))).toMatchObject({ code: "missing" });
    expect(await refusal(numbers.commandCanonicalPatientNumber(await fx.session("doctor"), String(ids.other), {
      patientNumber: "90031", expectedPatientNumber: "P-90002", expectedVersion: "1", reason: "خارج النطاق",
    }))).toMatchObject({ code: "missing" });
    expect((await q("SELECT patient_number FROM patients WHERE id=$1", [ids.other]))[0].patient_number).toBe("P-90002");
    expect((await q("SELECT count(*)::int AS n FROM audit_log WHERE action='patient.number.change' AND entity_id=$1::text", [ids.other]))[0].n).toBe(0);
  });

  it("revoking the grant refuses an earlier session and writes nothing", async () => {
    const issued = await fx.session("clerk");
    const current = await numbers.readCanonicalPatientNumber(issued, String(ids.mine));
    await fx.setGrants("clerk", { "patients.edit": true }, { patientScope: "all" });
    try {
      await expect(numbers.commandCanonicalPatientNumber(issued, String(ids.mine), {
        patientNumber: "90041", expectedPatientNumber: current.patientNumber, expectedVersion: current.version, reason: "بعد السحب",
      })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("clerk", { ...MANAGE }, { patientScope: "all" }); }
    expect((await q("SELECT patient_number FROM patients WHERE id=$1", [ids.mine]))[0].patient_number).toBe(current.patientNumber);
  });
});
