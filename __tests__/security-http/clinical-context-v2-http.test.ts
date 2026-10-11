import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, harness, loginStaff } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture, type StrategyFixture } from "./_ortho-strategy-live-fixture";
import { ROLES } from "../../lib/roles";

/** Real HTTP and isolated PG READ fixtures. Inserted graph edges do not prove creation/signing writers. */
let h: Awaited<ReturnType<typeof harness>>, fixture: StrategyFixture, roleFixture: StrategyFixture;
let visitId = 0, otherPlanId = 0;
beforeAll(async () => {
  assertStrategyCiBoundary(); h = await harness();
  fixture = await createStrategyFixture(h, "V2 exact visit and plan");
  roleFixture = await createStrategyFixture(h, "V2 private permission owner");
  visitId = (await fixture.db.query<{ id: number }>(`INSERT INTO visits(patient_id,patient_name,doctor_id,status)
    VALUES($1,'Synthetic reader fixture',$2,'in_chair') RETURNING id`, [fixture.patientId, fixture.partyId])).rows[0].id;
  await fixture.db.query("UPDATE plan_items SET visit_id=$1 WHERE id=$2 AND plan_id=$3", [visitId, fixture.itemId, fixture.planId]);
  // The same actual visit can have an adjustment for another case; plan-only context must not adopt it.
  const otherOrtho = (await fixture.db.query<{ id: number }>("INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'completed') RETURNING id", [fixture.patientId,fixture.username])).rows[0].id;
  await fixture.db.query("INSERT INTO ortho_adjustments(case_id,visit_id,done,recorded_by) VALUES($1,$2,'Synthetic other-case adjustment',$3)", [otherOrtho,visitId,fixture.username]);
  otherPlanId = (await fixture.db.query<{ id: number }>(`INSERT INTO treatment_plans(patient_id,title,total_minor,base_currency,created_by)
    VALUES($1,'Synthetic unrelated sibling plan',0,'YER',$2) RETURNING id`, [fixture.patientId, fixture.username])).rows[0].id;
  await fixture.db.query(`INSERT INTO plan_items(plan_id,case_id,service_name,unit_price_minor,status)
    VALUES($1,$2,'Synthetic same-case item without visit edge',0,'planned')`, [otherPlanId, fixture.clinicalCaseId]);
}, 120000);
afterAll(async () => { await fixture?.close(); await roleFixture?.close(); });
describe("clinical context V2 graph and canonical route", () => {
  it("accepts recorded visit→item→plan but refuses another plan even when both plans share a case", async () => {
    const before = await fixture.snapshot();
    for (const [planId, expected] of [[fixture.planId, 200], [otherPlanId, 409]]) {
      const response = await authedGet(`/api/patients/${fixture.patientId}/clinical-context?visitId=${visitId}&planId=${planId}`, fixture.session);
      const payload = await response.json(); expect(response.status, JSON.stringify(payload)).toBe(expected);
      if (expected === 200) { expect(payload.context).toEqual({ patientId: fixture.patientId, visitId, planId }); }
      else expect(payload.reason).toBe("context_mismatch");
    }
    const sharedCase = await authedGet(`/api/patients/${fixture.patientId}/clinical-context?visitId=${visitId}&planId=${otherPlanId}&clinicalCaseId=${fixture.clinicalCaseId}`, fixture.session);
    expect(sharedCase.status).toBe(409); expect(await fixture.snapshot()).toEqual(before);
  });
  it("rejects noncanonical path IDs and values above the actual database INTEGER bound", async () => {
    for (const pathId of [`0${fixture.patientId}`, `${fixture.patientId}e0`, `+${fixture.patientId}`, "2147483648"]) {
      const response = await authedGet(`/api/patients/${pathId}/clinical-context`, fixture.session);
      expect(response.status).toBe(400);
    }
    expect((await authedGet(`/api/patients/${fixture.patientId}/clinical-context?planId=2147483648`, fixture.session)).status).toBe(400);
  });
  it("passes only registered clinic roles and denies every excluded role through the built app", async () => {
    const path = `/api/patients/${fixture.patientId}/clinical-context`;
    for (const session of [h.sessions.admin, h.sessions.reception, fixture.session]) expect((await authedGet(path, session)).status).toBe(200);
    for (const session of [{ cookie: "" }, h.sessions.portalA]) expect([401,403]).toContain((await authedGet(path, session)).status);
    // Only this fixture's private user is changed; shared seeded users are untouched.
    try {
      for (const role of ROLES.filter((role) => !["admin", "reception", "doctor"].includes(role))) {
        await roleFixture.assertDatabaseIdentity();
        await roleFixture.db.query("UPDATE users SET role=$1 WHERE id=$2 AND username=$3", [role, roleFixture.userId, roleFixture.username]);
        const session = await loginStaff(roleFixture.username, roleFixture.password);
        expect([401,403]).toContain((await authedGet(`/api/patients/${roleFixture.patientId}/clinical-context`, session)).status);
      }
    } finally { await roleFixture.db.query("UPDATE users SET role='doctor' WHERE id=$1 AND username=$2", [roleFixture.userId, roleFixture.username]); }
  });
});
