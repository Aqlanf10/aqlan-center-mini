import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { authedGet, harness } from "./_server";
import { assertStrategyCiBoundary, createStrategyFixture, type StrategyFixture } from "./_ortho-strategy-live-fixture";

/** Real resolver HTTP / PostgreSQL tests. Reuses the combined 0047/0051 CI-owned
 * fixture; graph rows are synthetic persisted fixtures, not proof of case-creation
 * writers. Full writer journeys live in unified-linkage-legacy-reception-journey.
 * No mocks, no new reset/drop path, no mutation of the shared seeded users.
 */
let h: Awaited<ReturnType<typeof harness>>;
let first: StrategyFixture;
let foreign: StrategyFixture;
let closed: StrategyFixture;
let newerId = 0;
let newClinicalId = 0;
beforeAll(async () => {
  assertStrategyCiBoundary();
  h = await harness();
  first = await createStrategyFixture(h, "unified resolver current");
  foreign = await createStrategyFixture(h, "unified resolver other patient");
  closed = await createStrategyFixture(h, "unified resolver closed", { status: "completed" });
  // Controlled graph fixture for the READ contract, not a case-creation journey.
  newerId = (await closed.db.query<{ id: number }>(
    "INSERT INTO ortho_cases(patient_id,created_by,status) VALUES($1,$2,'active') RETURNING id",
    [closed.patientId, closed.username])).rows[0].id;
  newClinicalId = (await closed.db.query<{ id: number }>(`INSERT INTO clinical_cases
    (patient_id,specialty,title,site,ortho_case_id,created_by)
    VALUES($1,'orthodontics','Synthetic later episode','upper and lower',$2,$3) RETURNING id`,
  [closed.patientId, newerId, closed.username])).rows[0].id;
}, 120_000);
afterAll(async () => { await Promise.all([first, foreign, closed].filter(Boolean).map(fixture => fixture.close())); });

async function resolve(fixture: StrategyFixture, query: string, status = 200) {
  const response = await authedGet(`/api/patients/${fixture.patientId}/clinical-context?${query}`, fixture.session);
  const text = await response.text();
  expect(response.status, text).toBe(status);
  if (status === 200) expect(response.headers.get("cache-control")).toContain("no-store");
  return JSON.parse(text);
}

describe("Unified treatment context resolves exact recorded edges", () => {
  it("item, clinical case and specialty case converge without creating or billing anything", async () => {
    const before = await first.snapshot();
    const item = await resolve(first, `planItemId=${first.itemId}&pillar=diagnostics`);
    expect(item).toMatchObject({ ok: true, specialty: "orthodontics", sub: "ortho", context: {
      patientId: first.patientId, planId: first.planId, planItemId: first.itemId,
      clinicalCaseId: first.clinicalCaseId, orthoCaseId: first.orthoCaseId, pillar: "diagnostics",
    } });
    for (const query of [`clinicalCaseId=${first.clinicalCaseId}`, `orthoCaseId=${first.orthoCaseId}`]) {
      expect(await resolve(first, query)).toMatchObject({ ok: true, context: {
        patientId: first.patientId, clinicalCaseId: first.clinicalCaseId, orthoCaseId: first.orthoCaseId,
      } });
    }
    expect(await first.snapshot()).toEqual(before);
  });

  it("plan-only navigation does not invent a case/item, even when one seems obvious", async () => {
    const result = await resolve(first, `planId=${first.planId}`);
    expect(result.context).toEqual({ patientId: first.patientId, planId: first.planId });
    expect(result.sub).toBe("cases");
  });

  it("closed history remains addressable after a new specialty case exists for that same patient", async () => {
    const before = await closed.snapshot();
    expect(await resolve(closed, `planItemId=${closed.itemId}&pillar=diagnostics`)).toMatchObject({
      context: { orthoCaseId: closed.orthoCaseId, clinicalCaseId: closed.clinicalCaseId },
    });
    expect(await resolve(closed, `orthoCaseId=${newerId}`)).toMatchObject({
      context: { orthoCaseId: newerId, clinicalCaseId: newClinicalId },
    });
    expect(await resolve(closed, `planItemId=${closed.itemId}&orthoCaseId=${newerId}`, 409))
      .toMatchObject({ reason: "context_mismatch" });
    expect(await closed.snapshot()).toEqual(before);
  });

  it("cross-patient and conflicting explicit edges refuse rather than falling back to latest", async () => {
    const before = await first.snapshot();
    for (const query of [`planItemId=${foreign.itemId}`, `orthoCaseId=${foreign.orthoCaseId}`,
      `clinicalCaseId=${foreign.clinicalCaseId}`, `planId=${foreign.planId}`]) {
      expect(await resolve(first, query, 404)).toMatchObject({ reason: "not_found" });
    }
    expect(await resolve(first, `patientId=${foreign.patientId}`, 409)).toMatchObject({ reason: "context_mismatch" });
    expect(await resolve(first, `planItemId=${first.itemId}&clinicalCaseId=${foreign.clinicalCaseId}`, 409))
      .toMatchObject({ reason: "context_mismatch" });
    expect(await first.snapshot()).toEqual(before);
  });

  it("historical signed visit reads its recorded closed Ortho case, never today's open case", async () => {
    // Historical-row fixture only. It does not claim that SQL insertion proves signing.
    const visits = await closed.db.query<{ id: number }>(`INSERT INTO visits
      (patient_id, patient_name, doctor_id, status, signed_at, signed_by, arrived_at, treatment_done)
      VALUES ($1,'Synthetic recorded history',$2,'done',NOW()-INTERVAL '30 days',$3,NOW()-INTERVAL '30 days','Recorded care'),
             ($1,'Synthetic history without adjustment',$2,'done',NOW()-INTERVAL '20 days',$3,NOW()-INTERVAL '20 days','Recorded care') RETURNING id`,
    [closed.patientId, closed.partyId, closed.username]);
    const [withAdjustment, withoutAdjustment] = visits.rows;
    const adjustmentId = (await closed.db.query<{ id: number }>(`INSERT INTO ortho_adjustments
      (case_id,visit_id,done_on,upper_wire,lower_wire,done,recorded_by)
      VALUES($1,$2,CURRENT_DATE-30,'014 NiTi','012 NiTi','Synthetic retained adjustment',$3) RETURNING id`,
    [closed.orthoCaseId, withAdjustment.id, closed.username])).rows[0].id;
    const before = await closed.snapshot();
    const recordedResponse = await authedGet(`/api/visits/${withAdjustment.id}/clinical`, closed.session);
    expect(recordedResponse.status).toBe(200);
    expect(await recordedResponse.json()).toMatchObject({ ortho: {
      caseId: closed.orthoCaseId, visitAdjustmentId: adjustmentId,
      upperWire: "014 NiTi", lowerWire: "012 NiTi", suggestedUpper: null, suggestedLower: null,
    } });
    const unrecordedResponse = await authedGet(`/api/visits/${withoutAdjustment.id}/clinical`, closed.session);
    expect(unrecordedResponse.status).toBe(200);
    expect(await unrecordedResponse.json()).toMatchObject({ ortho: null });
    expect(await resolve(closed, `visitId=${withAdjustment.id}`)).toMatchObject({
      context: { visitId: withAdjustment.id, orthoCaseId: closed.orthoCaseId, clinicalCaseId: closed.clinicalCaseId },
    });
    expect(await closed.snapshot()).toEqual(before);
  });

  it("malformed or duplicate identity fields fail closed before choosing work", async () => {
    const before = await first.snapshot();
    for (const query of ["planItemId=0", "orthoCaseId=-1", "clinicalCaseId=1.5", "visitId=9007199254740992",
      `planItemId=${first.itemId}&planItemId=${first.itemId}`, "pillar=unknown"]) {
      await resolve(first, query, 400);
    }
    expect(await first.snapshot()).toEqual(before);
  });

  it("plan-view revocation takes effect for an existing session and cannot be bypassed with item ID", async () => {
    await first.setPermissions({ canViewPlans: false });
    try {
      const before = await first.snapshot();
      await resolve(first, `planId=${first.planId}`, 403);
      await resolve(first, `planItemId=${first.itemId}`, 403);
      // Case access remains separate; the endpoint must not accidentally disclose plan rows.
      const caseOnly = await resolve(first, `orthoCaseId=${first.orthoCaseId}`);
      expect(caseOnly.context).not.toHaveProperty("planId");
      expect(caseOnly.context).not.toHaveProperty("planItemId");
      expect(await first.snapshot()).toEqual(before);
    } finally { await first.setPermissions({ canViewPlans: true }); }
  });

  it("anonymous and patient-portal sessions cannot use this staff context API", async () => {
    const path = `/api/patients/${first.patientId}/clinical-context?planItemId=${first.itemId}`;
    expect((await authedGet(path, { cookie: "" })).status).toBe(401);
    expect((await authedGet(path, h.sessions.portalA)).status).toBe(401);
  });
});
