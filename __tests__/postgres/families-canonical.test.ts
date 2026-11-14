/** M2 slice 72: canonical patient families on real PostgreSQL, synthetic data only.
 * Members inside the patient scope; an `own` scope never learns a family it has no
 * member in; balances, totals and the guarantor's phone only with
 * finance.patient-ledger.view (owner rule); writes under patients.edit with the legacy
 * writer bodies; create idempotent by request key; revocation and concurrency. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-families-2026");
const db = await import("../../lib/db");
const fam = await import("../../lib/canonical-families");

const ACCOUNTS = {
  owner: { username: "SYN-FAM-OWNER", role: "admin" },
  reception: { username: "SYN-FAM-REC", role: "reception", patientScope: "all", grants: { "patients.edit": true } },
  readOnly: { username: "SYN-FAM-READ", role: "reception", patientScope: "all", grants: {} },
  ledger: { username: "SYN-FAM-LEDGER", role: "accountant", patientScope: "all", grants: { "finance.patient-ledger.view": true } },
  doctor: { username: "SYN-FAM-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "patients.edit": true, "finance.patient-ledger.view": true } },
  noScope: { username: "SYN-FAM-NOSCOPE", role: "reception", grants: { "patients.edit": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);
const key = () => `syn-family-key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ids = { mine: 0, mine2: 0, other: 0, other2: 0, loose: 0, mixed: 0, foreign: 0 };

async function patient(number: string, name: string, phone: string, doctor: number | null) {
  return (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,$3,$4) RETURNING id", [number, name, phone, doctor]))[0].id as number;
}
async function family(name: string, members: number[], guarantor: number | null = null, externalPhone: string | null = null) {
  const id = (await q("INSERT INTO patient_families(name,guarantor_patient_id,guarantor_name,guarantor_phone,created_by) VALUES ($1,$2,$3,$4,'synthetic') RETURNING id",
    [name, guarantor, externalPhone ? "ضامن خارجي" : null, externalPhone]))[0].id as number;
  for (const member of members) await q("UPDATE patients SET family_id=$1 WHERE id=$2", [id, member]);
  return id;
}
const audits = async (action: string) => (await q("SELECT actor FROM audit_log WHERE action=$1 ORDER BY id", [action])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const doctor = fx.parties.doctor!;
  ids.mine = await patient("SYN-FAM-1", "سارة اختبار", "0500000901", doctor);
  ids.mine2 = await patient("SYN-FAM-2", "ليلى اختبار", "0500000902", doctor);
  ids.other = await patient("SYN-FAM-3", "خالد بعيد", "0500000903", null);
  ids.other2 = await patient("SYN-FAM-4", "هدى بعيدة", "0500000904", null);
  ids.loose = await patient("SYN-FAM-5", "مريض حر", "0500000905", null);
  // A mixed family: one of the doctor's patients, one not; the guarantor is outside.
  ids.mixed = await family("عائلة مختلطة", [ids.mine, ids.other], ids.other2);
  ids.foreign = await family("عائلة بعيدة", [ids.other2], null, "0500000999");
  await q("INSERT INTO patient_opening_balances(patient_id,currency,amount_minor,as_of_date,created_by) VALUES ($1,'YER',7000,'2031-01-01','synthetic')", [ids.mine]);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("reads", () => {
  it("an all-scope reader without the ledger grant sees every member and no money at all", async () => {
    const view = await fam.readCanonicalFamily(await fx.session("readOnly"), String(ids.mixed));
    expect(view.members.map(member => member.id)).toEqual([ids.mine, ids.other]);
    expect(view).toMatchObject({ canSeeMoney: false, canEdit: false, guarantor: { kind: "patient", patientId: ids.other2, hidden: false, phone: null } });
    expect(view).not.toHaveProperty("totals");
    expect(view.members.every(member => !("balances" in member))).toBe(true);
    expect(JSON.stringify(view)).not.toContain("7000");
  });
  it("the ledger grant adds balances, totals and the guarantor's phone, from the canonical engine", async () => {
    const view = await fam.readCanonicalFamily(await fx.session("ledger"), String(ids.mixed));
    expect(view.canSeeMoney).toBe(true);
    expect(view.members.find(member => member.id === ids.mine)?.balances).toEqual([{ currency: "YER", balanceMinor: 7000 }]);
    expect(view.totals).toEqual([{ currency: "YER", balanceMinor: 7000 }]);
    expect(view.guarantor.phone).toBe("0500000904");
  });
  it("an own scope sees only its members, an unnamed guarantor, and never a family without its patients", async () => {
    const doctor = await fx.session("doctor");
    const view = await fam.readCanonicalFamily(doctor, String(ids.mixed));
    expect(view.members.map(member => member.id)).toEqual([ids.mine]);
    expect(view.guarantor).toEqual({ kind: "patient", patientId: null, patientNumber: null, name: null, phone: null, hidden: true });
    expect(view.totals).toEqual([{ currency: "YER", balanceMinor: 7000 }]);
    expect(await refusal(fam.readCanonicalFamily(doctor, String(ids.foreign)))).toMatchObject({ code: "family_not_found", status: 404 });
    expect(await refusal(fam.readCanonicalFamily(doctor, "999999"))).toMatchObject({ code: "family_not_found", status: 404 });
    // The patient file's panel: the doctor's own patient; another patient reads as missing.
    expect((await fam.readCanonicalPatientFamily(doctor, ids.mine)).family?.id).toBe(ids.mixed);
    expect(await refusal(fam.readCanonicalPatientFamily(doctor, ids.other))).toMatchObject({ code: "patient_not_found" });
    expect(await fam.readCanonicalPatientFamily(await fx.session("readOnly"), ids.loose)).toEqual({ family: null, canEdit: false });
    await expect(fam.readCanonicalFamily(await fx.session("noScope"), String(ids.mixed))).rejects.toThrow("RECORD_SCOPE_DENIED");
  });
  it("search and phone suggestions need patients.edit and stay inside the scope", async () => {
    const reception = await fx.session("reception");
    expect((await fam.readCanonicalFamilySearch(reception, new URLSearchParams("q=بعيد"))).families?.map(row => row.id).sort())
      .toEqual([ids.mixed, ids.foreign].sort());
    expect((await fam.readCanonicalFamilySearch(reception, new URLSearchParams("phone=0500000999"))).suggestions?.map(row => row.familyId)).toEqual([ids.foreign]);
    const doctor = await fx.session("doctor");
    // «خالد بعيد» is outside the doctor's scope: neither family matches through him.
    expect((await fam.readCanonicalFamilySearch(doctor, new URLSearchParams("q=بعيد"))).families).toEqual([]);
    expect((await fam.readCanonicalFamilySearch(doctor, new URLSearchParams("q=مختلطة"))).families).toEqual([{ id: ids.mixed, name: "عائلة مختلطة", memberCount: 1 }]);
    expect((await fam.readCanonicalFamilySearch(doctor, new URLSearchParams("phone=0500000999"))).suggestions).toEqual([]);
    expect((await fam.readCanonicalFamilySearch(doctor, new URLSearchParams("phone=0500000903"))).suggestions).toEqual([]);
    expect((await fam.readCanonicalFamilySearch(doctor, new URLSearchParams("phone=0500000901"))).suggestions?.map(row => row.familyId)).toEqual([ids.mixed]);
    await expect(fam.readCanonicalFamilySearch(await fx.session("readOnly"), new URLSearchParams("q=بعيد"))).rejects.toThrow("CAPABILITY_DENIED");
  });
});

describe("writes", () => {
  it("create is idempotent by request key: a concurrent double press makes one family; a reused key with another body is refused", async () => {
    const reception = await fx.session("reception");
    const p = await patient("SYN-FAM-6", "سالم مزدوج", "0500000906", null);
    const body = { requestKey: key(), name: "عائلة مزدوجة", members: [{ patientId: p, role: "father" }] };
    const [a, b] = await Promise.all([fam.commandCanonicalFamilyCreate(reception, body), fam.commandCanonicalFamilyCreate(await fx.session("reception"), body)]);
    expect(a.id).toBe(b.id);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect((await q("SELECT count(*)::int AS n FROM patient_families WHERE name='عائلة مزدوجة'"))[0].n).toBe(1);
    expect(await refusal(fam.commandCanonicalFamilyCreate(reception, { ...body, name: "اسم آخر" }))).toMatchObject({ code: "family_request_key_reused", status: 409 });
    expect(await refusal(fam.commandCanonicalFamilyCreate(reception, { name: "بلا مفتاح" }))).toMatchObject({ code: "invalid_family", status: 400, field: "requestKey" });
    expect(a).not.toHaveProperty("totals");
    expect((await q("SELECT actor, details->>'requestKey' AS k FROM audit_log WHERE action='family.create' AND entity_id=$1::text", [a.id]))).toEqual([{ actor: "SYN-FAM-REC", k: body.requestKey }]);
  });
  it("an own scope creates, links and unlinks only its own patients; outside answers like missing and writes nothing", async () => {
    const doctor = await fx.session("doctor");
    expect(await refusal(fam.commandCanonicalFamilyCreate(doctor, { requestKey: key(), name: "عائلة ممنوعة", members: [{ patientId: ids.loose }] })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(fam.commandCanonicalFamilyCreate(doctor, { requestKey: key(), name: "عائلة ممنوعة", guarantor: { kind: "patient", patientId: ids.loose } })))
      .toMatchObject({ code: "guarantor_not_found", status: 404 });
    expect((await q("SELECT count(*)::int AS n FROM patient_families WHERE name='عائلة ممنوعة'"))[0].n).toBe(0);
    // Linking its own patient into a family it cannot see is refused like a missing family.
    expect(await refusal(fam.commandCanonicalFamilyLink(doctor, String(ids.foreign), { patientId: ids.mine2 }))).toMatchObject({ code: "family_not_found", status: 404 });
    expect(await refusal(fam.commandCanonicalFamilyLink(doctor, String(ids.mixed), { patientId: ids.loose }))).toMatchObject({ code: "patient_not_found" });
    const linked = await fam.commandCanonicalFamilyLink(doctor, String(ids.mixed), { patientId: ids.mine2, role: "daughter" });
    expect(linked.members.map(member => member.id)).toEqual([ids.mine, ids.mine2]);
    expect(await refusal(fam.commandCanonicalFamilyUnlink(doctor, String(ids.mixed), String(ids.other)))).toMatchObject({ code: "patient_not_found" });
    expect((await fam.commandCanonicalFamilyUnlink(doctor, String(ids.mixed), String(ids.mine2))).members.map(member => member.id)).toEqual([ids.mine]);
    expect((await q("SELECT family_id FROM patients WHERE id=$1", [ids.other]))[0].family_id).toBe(ids.mixed);
  });
  it("rename, note and guarantor keep the legacy rules and audit rows; already in another family is 409", async () => {
    const reception = await fx.session("reception");
    const renamed = await fam.commandCanonicalFamilyUpdate(reception, String(ids.foreign), { name: "عائلة بعيدة جدًا", note: "ملاحظة اصطناعية" });
    expect(renamed).toMatchObject({ name: "عائلة بعيدة جدًا", note: "ملاحظة اصطناعية", canSeeMoney: false });
    expect(await refusal(fam.commandCanonicalFamilyUpdate(reception, String(ids.foreign), {}))).toMatchObject({ code: "invalid_family", status: 400 });
    const guaranteed = await fam.commandCanonicalFamilyGuarantor(reception, String(ids.foreign), { guarantor: { kind: "external", name: "ضامن جديد", phone: "0500000777" } });
    // Write responses never carry money — the guarantor's phone included.
    expect(guaranteed.guarantor).toMatchObject({ kind: "external", name: "ضامن جديد", phone: null });
    expect((await q("SELECT guarantor_phone FROM patient_families WHERE id=$1", [ids.foreign]))[0].guarantor_phone).toBe("0500000777");
    expect(await refusal(fam.commandCanonicalFamilyLink(reception, String(ids.foreign), { patientId: ids.other }))).toMatchObject({ code: "already_in_family", status: 409 });
    expect(await audits("family.rename")).toContain("SYN-FAM-REC");
    expect(await audits("family.guarantor")).toContain("SYN-FAM-REC");
  });
  it("two concurrent links of one patient to two families: exactly one wins, the other is refused", async () => {
    const p = await patient("SYN-FAM-7", "مريض متسابق", "0500000907", null);
    const left = await family("عائلة يسار", []), right = await family("عائلة يمين", []);
    const results = await Promise.allSettled([
      fam.commandCanonicalFamilyLink(await fx.session("reception"), String(left), { patientId: p }),
      fam.commandCanonicalFamilyLink(await fx.session("reception"), String(right), { patientId: p }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(result => result.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ code: "already_in_family", status: 409 });
    expect([left, right]).toContain((await q("SELECT family_id FROM patients WHERE id=$1", [p]))[0].family_id);
  });
  it("needs patients.edit and a scope; a revoked session is refused and nothing is written", async () => {
    await expect(fam.commandCanonicalFamilyUpdate(await fx.session("readOnly"), String(ids.foreign), { note: "x" })).rejects.toThrow("CAPABILITY_DENIED");
    await expect(fam.commandCanonicalFamilyUpdate(await fx.session("noScope"), String(ids.foreign), { note: "x" })).rejects.toThrow("RECORD_SCOPE_DENIED");
    const issued = await fx.session("reception");
    await fx.setGrants("reception", {}, { patientScope: "all" });
    try {
      await expect(fam.commandCanonicalFamilyUpdate(issued, String(ids.foreign), { note: "بعد السحب" })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("reception", { "patients.edit": true }, { patientScope: "all" }); }
    expect((await q("SELECT note FROM patient_families WHERE id=$1", [ids.foreign]))[0].note).toBe("ملاحظة اصطناعية");
  });
});
