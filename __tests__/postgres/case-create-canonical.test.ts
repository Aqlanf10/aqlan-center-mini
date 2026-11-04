/** M2 slice 80: canonical case opening on real PostgreSQL, synthetic data only.
 * clinical.plans.edit inside the patient scope by the clinician link or the owner; ortho
 * needs clinical.ortho.view; the initial responsibility rule; the request-key receipt
 * (double press and a reused key); refusals write nothing; revocation. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-case-create-secret-2026");
const db = await import("../../lib/db");
const cases = await import("../../lib/canonical-case-create");

const EDIT = { "clinical.plans.view": true, "clinical.plans.edit": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-CC-OWNER", role: "admin" },
  doctor: { username: "SYN-CC-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { ...EDIT } },
  other: { username: "SYN-CC-OTHER", role: "doctor", doctor: true, patientScope: "all", grants: { ...EDIT } },
  planner: { username: "SYN-CC-PLAN", role: "reception", patientScope: "all", grants: { ...EDIT } },
  viewer: { username: "SYN-CC-VIEW", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const key = () => `syn-case-key-${Math.random().toString(36).slice(2)}-${Date.now()}`;
const ids = { mine: 0, other: 0, far: 0 };
const count = async (patientId: number) => (await q("SELECT count(*)::int AS n FROM clinical_cases WHERE patient_id=$1", [patientId]))[0].n as number;

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000931',$3) RETURNING id", [number, `SYN CC ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-CC-1", fx.parties.doctor!);
  ids.other = await patient("SYN-CC-2", null);
  // Never linked to the doctor (a case naming them as responsible would bring "other" into their scope).
  ids.far = await patient("SYN-CC-3", null);
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("open a case", () => {
  it("the clinician opens a case with its audit; a keyed double press opens one; a reused key is refused", async () => {
    const body = { requestKey: key(), specialty: "endodontics", title: "علاج عصب اصطناعي — سن 36", site: "36", responsiblePartyId: fx.parties.doctor };
    const [a, b] = await Promise.all([
      cases.commandCanonicalCaseCreate(await fx.session("doctor"), String(ids.mine), body),
      cases.commandCanonicalCaseCreate(await fx.session("doctor"), String(ids.mine), body),
    ]);
    expect(a.caseId).toBe(b.caseId);
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
    expect(await count(ids.mine)).toBe(1);
    expect((await q("SELECT responsible_party_id, created_by FROM clinical_cases WHERE id=$1", [a.caseId]))[0]).toEqual({ responsible_party_id: fx.parties.doctor, created_by: "SYN-CC-DOC" });
    expect((await q("SELECT actor FROM audit_log WHERE action='case.create' AND details->>'requestKey'=$1", [body.requestKey])).map(row => row.actor)).toEqual(["SYN-CC-DOC"]);
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("doctor"), String(ids.mine), { ...body, title: "آخر" })))
      .toMatchObject({ code: "case_request_key_reused", status: 409 });
  });

  it("a clinician names only themself; the owner may name any active doctor", async () => {
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("other"), String(ids.mine), { requestKey: key(), specialty: "endodontics", title: "إسناد لغيره", responsiblePartyId: fx.parties.doctor })))
      .toMatchObject({ code: "case_create_bad_responsible", status: 400 });
    const owned = await cases.commandCanonicalCaseCreate(await fx.session("owner"), String(ids.other), { requestKey: key(), specialty: "periodontics", title: "لثة اصطناعية", responsiblePartyId: fx.parties.doctor });
    expect((await q("SELECT responsible_party_id FROM clinical_cases WHERE id=$1", [owned.caseId]))[0].responsible_party_id).toBe(fx.parties.doctor);
  });

  it("refuses without the clinician link, without the grant, outside the scope and for ortho without its view — writing nothing", async () => {
    const before = [await count(ids.mine), await count(ids.far)];
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("planner"), String(ids.mine), { requestKey: key(), specialty: "endodontics", title: "بلا طبيب" })))
      .toMatchObject({ code: "case_create_clinician_required", status: 403 });
    // The role-level check comes before validation (as legacy): an invalid body still reads 403.
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("planner"), String(ids.mine), { specialty: "nope" })))
      .toMatchObject({ code: "case_create_clinician_required", status: 403 });
    await expect(cases.commandCanonicalCaseCreate(await fx.session("viewer"), String(ids.mine), { requestKey: key(), specialty: "endodontics", title: "بلا صلاحية" })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("doctor"), String(ids.far), { requestKey: key(), specialty: "endodontics", title: "خارج النطاق" })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("doctor"), String(ids.mine), { requestKey: key(), specialty: "orthodontics", title: "تقويم" })))
      .toMatchObject({ code: "case_create_ortho_denied", status: 403 });
    expect(await refusal(cases.commandCanonicalCaseCreate(await fx.session("doctor"), String(ids.mine), { specialty: "endodontics", title: "بلا مفتاح" })))
      .toMatchObject({ status: 400 });
    expect([await count(ids.mine), await count(ids.far)]).toEqual(before);
  });

  it("revoking the grant refuses an earlier session and writes nothing", async () => {
    const issued = await fx.session("doctor");
    const before = await count(ids.mine);
    await fx.setGrants("doctor", { "clinical.plans.view": true }, { patientScope: "own" });
    try {
      await expect(cases.commandCanonicalCaseCreate(issued, String(ids.mine), { requestKey: key(), specialty: "endodontics", title: "بعد السحب" })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("doctor", { ...EDIT }, { patientScope: "own" }); }
    expect(await count(ids.mine)).toBe(before);
  });
});
