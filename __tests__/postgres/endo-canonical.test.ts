/** M2 slice 77: canonical endodontics on real PostgreSQL, synthetic data only.
 * Read by a clinical grant inside the patient scope (plan items only with
 * clinical.plans.view); writes by clinical.visits.document with the clinician link or the
 * owner; legacy bodies on the admitted transaction (audit rows, locks, replays); a refusal
 * rolls back; crown plan links need clinical.plans.edit; addenda need clinical.visits.sign;
 * revocation refuses an earlier session. */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-endodontics-secret-2026");
const db = await import("../../lib/db");
const endo = await import("../../lib/canonical-endo");

const DOC = { "clinical.visits.document": true } as const;
const ACCOUNTS = {
  owner: { username: "SYN-EN-OWNER", role: "admin" },
  doctor: { username: "SYN-EN-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { ...DOC, "clinical.visits.sign": true } },
  plain: { username: "SYN-EN-PLAIN", role: "doctor", doctor: true, patientScope: "all", grants: { ...DOC } },
  nurse: { username: "SYN-EN-NURSE", role: "assistant", patientScope: "all", grants: { ...DOC } },
  viewer: { username: "SYN-EN-VIEW", role: "reception", patientScope: "all", grants: { "clinical.xrays.view": true } },
  planner: { username: "SYN-EN-PLAN", role: "reception", patientScope: "all", grants: { "clinical.plans.view": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number }) => error);
const ids = { mine: 0, other: 0, caseMine: 0, caseOther: 0, visit: 0, treatment: 0 };
const audits = async (action: string, patientId: number) =>
  (await q("SELECT actor FROM audit_log WHERE action=$1 AND entity_id=$2::text ORDER BY id", [action, patientId])).map(row => row.actor);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000981',$3) RETURNING id", [number, `SYN EN ${number}`, doctor]))[0].id as number;
  ids.mine = await patient("SYN-EN-1", fx.parties.doctor!);
  ids.other = await patient("SYN-EN-2", null);
  const endoCase = async (patientId: number) =>
    (await q("INSERT INTO clinical_cases (patient_id, specialty, title, status, created_by) VALUES ($1,'endodontics','علاج جذور اصطناعي','active','SYN') RETURNING id", [patientId]))[0].id as number;
  ids.caseMine = await endoCase(ids.mine);
  ids.caseOther = await endoCase(ids.other);
  ids.visit = (await q("INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('SYN EN visit', $1, $2) RETURNING id", [ids.mine, fx.parties.doctor!]))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("open, record and close", () => {
  it("the clinician opens an episode with its audit; a second open on the same tooth is refused and rolled back", async () => {
    const opened = await endo.commandCanonicalEndoOpen(await fx.session("doctor"), String(ids.mine), { caseId: ids.caseMine, toothCode: 36, kind: "initial" });
    expect(opened.status).toBe(201);
    expect(opened.treatment).toMatchObject({ patientId: ids.mine, toothCode: 36, status: "in_progress" });
    ids.treatment = opened.treatment.id;
    expect(await audits("endo.open", ids.mine)).toEqual(["SYN-EN-DOC"]);
    expect(await refusal(endo.commandCanonicalEndoOpen(await fx.session("doctor"), String(ids.mine), { caseId: ids.caseMine, toothCode: 36 })))
      .toMatchObject({ code: "endo_tooth_busy", status: 409 });
    expect((await q("SELECT count(*)::int AS n FROM endo_treatments WHERE patient_id=$1", [ids.mine]))[0].n).toBe(1);
  });

  it("saves a visit record attributed to the clinician; the same draft replays without a second effect", async () => {
    const body = { visitId: ids.visit, stage: "assessment", pulpalDiagnosis: "symptomatic_irreversible_pulpitis", canalsFound: 3, canals: [{ label: "MB" }, { label: "ML" }, { label: "D" }] };
    const first = await endo.commandCanonicalEndoVisit(await fx.session("doctor"), String(ids.mine), String(ids.treatment), body);
    expect(first.status).toBe(201);
    expect(first.treatment.visits[0]).toMatchObject({ visitId: ids.visit, doctorId: fx.parties.doctor, version: 1 });
    const again = await endo.commandCanonicalEndoVisit(await fx.session("doctor"), String(ids.mine), String(ids.treatment), body);
    expect(again.status).toBe(200);
    expect(again.treatment.visits[0].version).toBe(1);
    expect(await audits("endo.visit_save", ids.mine)).toEqual(["SYN-EN-DOC"]);
    expect(await refusal(endo.commandCanonicalEndoVisit(await fx.session("doctor"), String(ids.mine), String(ids.treatment), { ...body, stage: "shaping" })))
      .toMatchObject({ code: "endo_exists", status: 409 });
  });

  it("an addendum needs the signed visit and clinical.visits.sign; its request key replays", async () => {
    const endoVisitId = (await q("SELECT id FROM endo_visits WHERE treatment_id=$1", [ids.treatment]))[0].id as number;
    const addendum = { text: "ملحق اصطناعي", requestKey: "syn-endo-addendum-0001" };
    expect(await refusal(endo.commandCanonicalEndoAddendum(await fx.session("doctor"), String(ids.mine), String(ids.treatment), String(endoVisitId), addendum)))
      .toMatchObject({ code: "endo_not_signed", status: 409 });
    await q("UPDATE visits SET signed_at = NOW(), signed_by = 'SYN-EN-DOC' WHERE id = $1", [ids.visit]);
    expect(await refusal(endo.commandCanonicalEndoAddendum(await fx.session("plain"), String(ids.mine), String(ids.treatment), String(endoVisitId), addendum)))
      .toMatchObject({ code: "endo_sign_required", status: 403 });
    const added = await endo.commandCanonicalEndoAddendum(await fx.session("doctor"), String(ids.mine), String(ids.treatment), String(endoVisitId), addendum);
    expect(added.status).toBe(201);
    expect((await endo.commandCanonicalEndoAddendum(await fx.session("doctor"), String(ids.mine), String(ids.treatment), String(endoVisitId), addendum)).status).toBe(200);
    expect((await q("SELECT count(*)::int AS n FROM endo_addenda WHERE endo_visit_id=$1", [endoVisitId]))[0].n).toBe(1);
    expect(await audits("endo.addendum", ids.mine)).toEqual(["SYN-EN-DOC"]);
  });

  it("crown plan links need clinical.plans.edit; the decision alone does not; abandon closes the episode", async () => {
    expect(await refusal(endo.commandCanonicalEndoCrown(await fx.session("doctor"), String(ids.mine), String(ids.treatment), { crownRequired: true, crownPlanItemId: 1, rctPlanItemId: 2 })))
      .toMatchObject({ code: "endo_plan_edit_required", status: 403 });
    const decided = await endo.commandCanonicalEndoCrown(await fx.session("doctor"), String(ids.mine), String(ids.treatment), { crownRequired: false });
    expect(decided.treatment.crownRequired).toBe(false);
    expect(await audits("endo.crown", ids.mine)).toEqual(["SYN-EN-DOC"]);
    const closed = await endo.commandCanonicalEndoStatus(await fx.session("owner"), String(ids.mine), String(ids.treatment), { status: "abandoned", outcome: "إيقاف اصطناعي" });
    expect(closed.treatment.status).toBe("abandoned");
    expect(await audits("endo.status", ids.mine)).toEqual(["SYN-EN-OWNER"]);
    expect(await refusal(endo.commandCanonicalEndoStatus(await fx.session("owner"), String(ids.mine), String(ids.treatment), { status: "completed" })))
      .toMatchObject({ code: "endo_invalid_transition", status: 409 });
  });
});

describe("refusals, reads and revocation", () => {
  it("refuses without the clinician link, without the grant and outside the scope — writing nothing", async () => {
    const before = (await q("SELECT count(*)::int AS n FROM endo_treatments"))[0].n;
    expect(await refusal(endo.commandCanonicalEndoOpen(await fx.session("nurse"), String(ids.mine), { caseId: ids.caseMine, toothCode: 46 })))
      .toMatchObject({ code: "endo_clinician_required", status: 403 });
    await expect(endo.commandCanonicalEndoOpen(await fx.session("viewer"), String(ids.mine), { caseId: ids.caseMine, toothCode: 46 })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await refusal(endo.commandCanonicalEndoOpen(await fx.session("doctor"), String(ids.other), { caseId: ids.caseOther, toothCode: 46 })))
      .toMatchObject({ code: "patient_not_found", status: 404 });
    expect((await q("SELECT count(*)::int AS n FROM endo_treatments"))[0].n).toBe(before);
    expect(await audits("endo.open", ids.other)).toEqual([]);
  });

  it("reads by a clinical grant inside the scope; plan items only with clinical.plans.view", async () => {
    const viewer = await endo.readCanonicalEndo(await fx.session("viewer"), ids.mine);
    expect(viewer.treatments.map(row => row.id)).toEqual([ids.treatment]);
    expect(viewer.treatments[0].crownPlanItem).toBeNull();
    expect((await endo.readCanonicalEndo(await fx.session("planner"), ids.mine)).treatments).toHaveLength(1);
    expect(await refusal(endo.readCanonicalEndo(await fx.session("doctor"), ids.other))).toMatchObject({ code: "patient_not_found" });
    expect(JSON.stringify(viewer)).not.toMatch(/price|amount|balance/i);
  });

  it("revoking the grant refuses an earlier session's write and writes nothing", async () => {
    const issued = await fx.session("doctor");
    const before = (await q("SELECT count(*)::int AS n FROM endo_treatments WHERE patient_id=$1", [ids.mine]))[0].n;
    await fx.setGrants("doctor", {}, { patientScope: "own" });
    try {
      await expect(endo.commandCanonicalEndoOpen(issued, String(ids.mine), { caseId: ids.caseMine, toothCode: 46 })).rejects.toThrow(/CREDENTIAL_OR_ACCOUNT|CAPABILITY_DENIED/);
    } finally { await fx.setGrants("doctor", { ...DOC, "clinical.visits.sign": true }, { patientScope: "own" }); }
    expect((await q("SELECT count(*)::int AS n FROM endo_treatments WHERE patient_id=$1", [ids.mine]))[0].n).toBe(before);
  });
});
