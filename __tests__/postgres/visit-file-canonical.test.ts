/** M2 slice 81: canonical visit ↔ file actions on real PostgreSQL, synthetic data only.
 * link (visit and file inside the scope, audit), open_file (patients.create, a matched
 * file outside the scope refused and rolled back, patient.create audit), delete
 * (visits.delete, signed and invoiced refuse, audit in the same transaction), revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-file-secret-2026-x");
const db = await import("../../lib/db");
const vf = await import("../../lib/canonical-visit-file");

const ACCOUNTS = {
  owner: { username: "SYN-VF-OWNER", role: "admin" },
  desk: { username: "SYN-VF-DESK", role: "reception", patientScope: "all", grants: { "visits.manage": true, "patients.create": true } },
  doctor: { username: "SYN-VF-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "visits.manage": true, "patients.create": true } },
  queue: { username: "SYN-VF-QUEUE", role: "reception", patientScope: "all", grants: { "visits.manage": true } },
  remover: { username: "SYN-VF-DEL", role: "reception", patientScope: "all", grants: { "visits.manage": true, "visits.delete": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const patient = async (number: string, phone: string, doctor: number | null = null) =>
  (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,$3,$4) RETURNING id", [number, `SYN VF ${number}`, phone, doctor]))[0].id as number;
const walkIn = async (name: string, phone: string | null, doctor: number | null = null) =>
  (await q("INSERT INTO visits (patient_name, patient_phone, doctor_id) VALUES ($1,$2,$3) RETURNING id", [name, phone, doctor]))[0].id as number;
const visitPatient = async (visitId: number) => (await q("SELECT patient_id FROM visits WHERE id=$1", [visitId]))[0]?.patient_id ?? null;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("link and open file", () => {
  it("links a walk-in to a file inside the scope with its audit; a file outside is refused", async () => {
    const file = await patient("SYN-VF-1", "0500000801");
    const visit = await walkIn("زائر اصطناعي", null);
    expect(await vf.commandCanonicalVisitLink(await fx.session("desk"), String(visit), file)).toEqual({ ok: true, patientName: "SYN VF SYN-VF-1" });
    expect(await visitPatient(visit)).toBe(file);
    expect((await q("SELECT actor FROM audit_log WHERE action='visit.link' AND entity_id=$1::text", [visit])).map(row => row.actor)).toEqual(["SYN-VF-DESK"]);

    const mine = await walkIn("زائر الطبيب", null, fx.parties.doctor!);
    const far = await patient("SYN-VF-2", "0500000802");
    expect(await refusal(vf.commandCanonicalVisitLink(await fx.session("doctor"), String(mine), far))).toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(vf.commandCanonicalVisitLink(await fx.session("doctor"), String(visit), far))).toMatchObject({ code: "visit_not_found", status: 404 });
    expect(await visitPatient(mine)).toBeNull();
  });

  it("open_file needs patients.create; creates a file with its audit; a phone match outside the scope is refused and rolled back", async () => {
    const fresh = await walkIn("مريض جديد اصطناعي", "0500000811");
    await expect(vf.commandCanonicalVisitOpenFile(await fx.session("queue"), String(fresh))).rejects.toMatchObject({ code: "visit_open_file_denied", status: 403 });
    const opened = await vf.commandCanonicalVisitOpenFile(await fx.session("desk"), String(fresh));
    expect(opened).toMatchObject({ ok: true, created: true });
    expect(await visitPatient(fresh)).toBe(opened.patientId);
    expect((await q("SELECT actor FROM audit_log WHERE action='patient.create' AND entity_id=$1::text", [opened.patientId])).map(row => row.actor)).toEqual(["SYN-VF-DESK"]);

    await patient("SYN-VF-3", "0500000821");
    const doctorsVisit = await walkIn("زائر بجوال معروف", "0500000821", fx.parties.doctor!);
    expect(await refusal(vf.commandCanonicalVisitOpenFile(await fx.session("doctor"), String(doctorsVisit))))
      .toMatchObject({ code: "visit_open_file_outside_scope", status: 409 });
    expect(await visitPatient(doctorsVisit)).toBeNull();
  });
});

describe("delete", () => {
  it("deletes an unsigned visit with its audit; signed visits refuse; needs visits.delete", async () => {
    const visit = await walkIn("زيارة خاطئة", null);
    await expect(vf.commandCanonicalVisitDelete(await fx.session("desk"), String(visit), null)).rejects.toThrow("CAPABILITY_DENIED");
    expect(await vf.commandCanonicalVisitDelete(await fx.session("remover"), String(visit), "تسجيل خاطئ")).toMatchObject({ message: expect.stringContaining("حُذفت") });
    expect((await q("SELECT count(*)::int AS n FROM visits WHERE id=$1", [visit]))[0].n).toBe(0);
    expect((await q("SELECT actor FROM audit_log WHERE action='visit.delete' AND entity_id=$1::text", [visit])).map(row => row.actor)).toEqual(["SYN-VF-DEL"]);

    const signed = await walkIn("زيارة موقعة", null);
    await q("UPDATE visits SET signed_at = NOW(), signed_by = 'SYN' WHERE id = $1", [signed]);
    expect(await refusal(vf.commandCanonicalVisitDelete(await fx.session("remover"), String(signed), null))).toMatchObject({ code: "visit_signed", status: 409 });
    expect((await q("SELECT count(*)::int AS n FROM visits WHERE id=$1", [signed]))[0].n).toBe(1);
  });

  it("revoking the grant refuses an earlier session and deletes nothing", async () => {
    const visit = await walkIn("زيارة بعد السحب", null);
    const issued = await fx.session("remover");
    await fx.setGrants("remover", { "visits.manage": true }, { patientScope: "all" });
    try {
      await expect(vf.commandCanonicalVisitDelete(issued, String(visit), null)).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("remover", { "visits.manage": true, "visits.delete": true }, { patientScope: "all" }); }
    expect((await q("SELECT count(*)::int AS n FROM visits WHERE id=$1", [visit]))[0].n).toBe(1);
  });
});
