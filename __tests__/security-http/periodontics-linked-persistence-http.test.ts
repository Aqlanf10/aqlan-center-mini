import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { PerioDraft, PerioObservation } from "../../lib/periodontics";
import type { PerioExamView } from "../../lib/periodontics-db";
import { authedGet, authedMutation, baseUrl } from "./_server";
import {
  createLinkedClinicalFixture, linkedClinicalSnapshot, openLinkedClinicalFixtures,
  type LinkedClinicalFixture,
} from "./_linked-clinical-fixtures";

/**
 * NEW AUTHORED UNRUN built-app HTTP candidate, not recovered historical proof.
 * Root review/integration and runtime approval are prerequisites. Uses only the
 * existing _server harness. Clinical commands cross real HTTP; SQL only creates
 * owned synthetic linked fixtures and observes committed state. No browser,
 * auth mocks, permission edits, migrations, triggers, or alternate server.
 */
let context: Awaited<ReturnType<typeof openLinkedClinicalFixtures>>;
let f: LinkedClinicalFixture;
let sequence = 0;
const stamp = Date.now();
type Payload = PerioDraft & { expectedRevision: number | null };
type Saved = { exam: PerioExamView; unchanged: boolean };
const initialSites = (): PerioObservation[] => [
  { toothCode: 11, site: "MB", probingDepthMm: 0, bleedingOnProbing: false },
  { toothCode: 11, site: "B", probingDepthMm: null, bleedingOnProbing: true },
  { toothCode: 55, site: "DL", probingDepthMm: 1.01, bleedingOnProbing: null },
  { toothCode: 55, site: "L", probingDepthMm: null, bleedingOnProbing: null },
];
const payload = (change: Partial<Payload> = {}): Payload => ({
  doctorId: f.doctorId, caseId: f.caseId, sites: initialSites(), expectedRevision: null, ...change,
});
const path = () => `/api/patients/${f.patientId}/perio`;
const savePath = () => `${path()}/visits/${f.visitId}`;
const snapshot = () => linkedClinicalSnapshot(context.db, f);
const put = (body: unknown, session = context.h.sessions.doctorA, headers: Record<string, string> = {}) =>
  authedMutation(savePath(), session, "PUT", JSON.stringify(body), headers);
const add = (examId: number, body: unknown, session = context.h.sessions.doctorA, headers: Record<string, string> = {}) =>
  authedMutation(`${path()}/exams/${examId}/addenda`, session, "POST", JSON.stringify(body), headers);
async function saved(body: Payload = payload(), status = 201): Promise<Saved> {
  const response = await put(body);
  expect(response.status).toBe(status);
  return await response.json() as Saved;
}
async function signLinkedVisit() {
  // Explicit sign of this already-linked, owned synthetic visit. This helper is
  // lifecycle setup for frozen persistence, not a target-authorization test.
  const response = await authedMutation(`/api/visits/${f.visitId}/clinical`, context.h.sessions.doctorA,
    "POST", JSON.stringify({ action: "sign" }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ signedBy: "secdoctora", invoiceId: null, duesMinor: 0 });
}

beforeAll(async () => { context = await openLinkedClinicalFixtures(); }, 120_000);
beforeEach(async () => {
  f = await createLinkedClinicalFixture(context.db, context.doctorId, `NEW-PERIO-HTTP-${stamp}-${++sequence}`);
});
afterAll(async () => { await context?.db.end(); });

describe("new linked periodontal persistence through built HTTP", () => {
  it("creates and reloads explicit null/zero/false observations with the exact patient, visit, case and provider", async () => {
    const before = await snapshot();
    const result = await saved();
    expect(result).toMatchObject({ unchanged: false, exam: {
      patientId: f.patientId, visitId: f.visitId, caseId: f.caseId, doctorId: f.doctorId,
      revision: 1, recordedBy: "secdoctora", updatedAt: null, signedAt: null, addenda: [],
      summary: { recordedDepthSites: 2, recordedBleedingSites: 2, bleedingSites: 1, bleedingPercent: 50 },
    } });
    expect(result.exam.sites).toEqual([initialSites()[0], initialSites()[1], initialSites()[3], initialSites()[2]]);
    const reload = await authedGet(path(), context.h.sessions.doctorA);
    expect(reload.status).toBe(200);
    expect(await reload.json()).toEqual({ exams: [result.exam] });
    const after = await snapshot();
    expect(after.visit).toEqual(before.visit);
    expect(after.procedures).toEqual([]);
    expect(after.exams).toHaveLength(1);
    expect(after.sites).toHaveLength(4);
    expect(after.perioAudits).toEqual([expect.objectContaining({ action: "perio.exam_save", actor: "secdoctora", actor_role: "doctor" })]);
    expect(after.invoices).toEqual([]);
    expect(after.payments).toEqual([]);
  });

  it("replays a lost create response without changing IDs, revision, times or audits", async () => {
    const first = await saved();
    const before = await snapshot();
    for (const expectedRevision of [null, 1]) {
      const retry = await saved(payload({ sites: [...initialSites()].reverse(), expectedRevision }), 200);
      expect(retry).toEqual({ exam: first.exam, unchanged: true });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("accepts an exact-revision complete replacement and preserves retained site identity", async () => {
    const first = await saved();
    const before = await snapshot();
    const sites: PerioObservation[] = [
      { ...initialSites()[0], probingDepthMm: 2.25, bleedingOnProbing: true },
      { toothCode: 12, site: "MB", probingDepthMm: null, bleedingOnProbing: false },
    ];
    const edited = await saved(payload({ expectedRevision: 1, sites }), 200);
    expect(edited).toMatchObject({ unchanged: false, exam: { id: first.exam.id, revision: 2, sites, updatedBy: "secdoctora" } });
    expect(edited.exam.recordedAt).toBe(first.exam.recordedAt);
    expect(edited.exam.updatedAt).toEqual(expect.any(String));
    const after = await snapshot();
    expect(after.sites).toHaveLength(2);
    expect(after.sites.find((row) => row.tooth_code === 11 && row.site === "MB")?.id)
      .toBe(before.sites.find((row) => row.tooth_code === 11 && row.site === "MB")?.id);
    expect(after.perioAudits).toHaveLength(2);
    expect(after.visit).toEqual(before.visit);
    expect(after.procedures).toEqual(before.procedures);
    expect(after.invoices).toEqual(before.invoices);
    expect(after.payments).toEqual(before.payments);
  });

  it("refuses stale changed content and future revisions while accepting a stale exact retry", async () => {
    await saved();
    const sites = [{ ...initialSites()[0], probingDepthMm: 3 }];
    const second = await saved(payload({ sites, expectedRevision: 1 }), 200);
    const before = await snapshot();
    const exactRetry = await saved(payload({ sites, expectedRevision: 1 }), 200);
    expect(exactRetry).toEqual({ exam: second.exam, unchanged: true });
    for (const body of [payload(), payload({ expectedRevision: 1 }), payload({ sites, expectedRevision: 3 })]) {
      const response = await put(body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "revision_conflict" });
      expect(await snapshot()).toEqual(before);
    }
  });

  it("serializes two HTTP edits from the same revision into one winner and one unchanged rejection", async () => {
    await saved();
    const before = await snapshot();
    const bodies = [4, 5].map((probingDepthMm) => payload({ expectedRevision: 1,
      sites: [{ ...initialSites()[0], probingDepthMm }] }));
    const responses = await Promise.all(bodies.map((body) => put(body)));
    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const winner = await responses.find((response) => response.status === 200)!.json() as Saved;
    const loser = await responses.find((response) => response.status === 409)!.json() as { code: string };
    expect(loser.code).toBe("revision_conflict");
    const reload = await authedGet(path(), context.h.sessions.doctorA);
    expect(reload.status).toBe(200);
    expect(await reload.json()).toEqual({ exams: [winner.exam] });
    const after = await snapshot();
    expect(after.exams).toHaveLength(1);
    expect(after.exams[0].revision).toBe(2);
    expect(after.sites).toHaveLength(1);
    expect(after.sites[0].id).toBe(before.sites.find((row) => row.tooth_code === 11 && row.site === "MB")?.id);
    expect(after.sites[0].probing_depth_mm).toBe(winner.exam.sites[0].probingDepthMm);
    expect(after.perioAudits).toHaveLength(2);
  });

  it("rejects malformed observation and revision payloads before changing saved rows", async () => {
    await saved();
    const before = await snapshot();
    const valid = payload({ expectedRevision: 1 });
    const invalid = [
      { ...valid, sites: [{ ...initialSites()[0], probingDepthMm: 1.234 }] },
      { ...valid, sites: [{ ...initialSites()[0], probingDepthMm: "3" }] },
      { ...valid, sites: [{ ...initialSites()[0], bleedingOnProbing: "false" }] },
      { ...valid, sites: [initialSites()[0], initialSites()[0]] },
      { ...valid, expectedRevision: 0 },
      { ...valid, expectedRevision: "1" },
    ];
    for (const body of invalid) {
      const response = await put(body);
      expect(response.status).toBe(400);
      expect((await response.json()).message).toEqual(expect.any(String));
      expect(await snapshot()).toEqual(before);
    }
  });

  it("allows linked clinical readers and refuses non-clinical writers without mutations", async () => {
    const first = await saved();
    const before = await snapshot();
    for (const session of [context.h.sessions.admin, context.h.sessions.doctorA, context.h.sessions.reception]) {
      const response = await authedGet(path(), session);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ exams: [first.exam] });
    }
    for (const session of [context.h.sessions.cashier, context.h.sessions.accountant]) {
      expect((await authedGet(path(), session)).status).toBe(403);
    }
    for (const session of [context.h.sessions.reception, context.h.sessions.cashier, context.h.sessions.accountant]) {
      expect((await put(payload({ expectedRevision: 1, sites: [] }), session)).status).toBe(403);
      expect(await snapshot()).toEqual(before);
    }
  });

  it("requires staff authentication and same-origin CSRF evidence for the linked save", async () => {
    const before = await snapshot();
    const body = JSON.stringify(payload());
    expect((await fetch(`${baseUrl}${savePath()}`, { method: "PUT", redirect: "manual",
      headers: { "Content-Type": "application/json", Origin: baseUrl }, body })).status).toBe(401);
    expect((await put(payload(), context.h.sessions.doctorA, { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await put(payload(), context.h.sessions.doctorA, { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect((await fetch(`${baseUrl}${savePath()}`, { method: "PUT", redirect: "manual",
      headers: { Cookie: context.h.sessions.doctorA.cookie, "Content-Type": "application/json" }, body })).status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect((await put(payload())).status).toBe(201);
  });

  it("signs meaningful linked Perio through HTTP without money and freezes even exact save retries", async () => {
    const first = await saved();
    await signLinkedVisit();
    const before = await snapshot();
    for (const body of [payload({ expectedRevision: 1 }), payload({ expectedRevision: 1, sites: [] })]) {
      const response = await put(body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "visit_signed" });
      expect(await snapshot()).toEqual(before);
    }
    const reload = await authedGet(path(), context.h.sessions.doctorA);
    expect(reload.status).toBe(200);
    const view = await reload.json() as { exams: PerioExamView[] };
    expect(view.exams[0]).toMatchObject({ id: first.exam.id, revision: 1, sites: first.exam.sites, signedBy: "secdoctora" });
    expect(view.exams[0].signedAt).toEqual(expect.any(String));
    expect(before.invoices).toEqual([]);
    expect(before.payments).toEqual([]);
  });

  it("rejects an addendum on the unsigned linked exam without creating a correction or audit", async () => {
    const first = await saved();
    const before = await snapshot();
    const response = await add(first.exam.id, { text: "Synthetic correction", requestKey: "linked-perio:unsigned" });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "not_signed" });
    expect(await snapshot()).toEqual(before);
  });

  it("appends a signed correction exactly once and binds retry identity to its body and author", async () => {
    const first = await saved();
    await signLinkedVisit();
    const before = await snapshot();
    const body = { text: "Synthetic linked correction", requestKey: "linked-perio:correction" };
    const response = await add(first.exam.id, body);
    expect(response.status).toBe(201);
    const added = await response.json() as Saved;
    expect(added).toMatchObject({ unchanged: false, exam: { id: first.exam.id, revision: 1,
      addenda: [{ body: body.text, author: "secdoctora" }] } });
    const after = await snapshot();
    expect(after.visit).toEqual(before.visit);
    expect(after.exams).toEqual(before.exams);
    expect(after.sites).toEqual(before.sites);
    expect(after.addenda).toHaveLength(1);
    expect(after.perioAudits).toHaveLength(before.perioAudits.length + 1);
    expect(after.perioAudits.at(-1)).toMatchObject({ action: "perio.addendum", actor: "secdoctora" });
    const retry = await add(first.exam.id, { ...body, text: `  ${body.text}  ` });
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ exam: added.exam, unchanged: true });
    for (const rejected of [
      await add(first.exam.id, { ...body, text: "Different correction" }),
      await add(first.exam.id, body, context.h.sessions.admin),
    ]) {
      expect(rejected.status).toBe(409);
      expect(await rejected.json()).toMatchObject({ code: "idempotency_conflict" });
    }
    expect(await snapshot()).toEqual(after);
    const reload = await authedGet(path(), context.h.sessions.reception);
    expect(reload.status).toBe(200);
    expect(await reload.json()).toEqual({ exams: [added.exam] });
  });

  it("enforces validation, roles, authentication and CSRF on the signed addendum route", async () => {
    const first = await saved();
    await signLinkedVisit();
    const before = await snapshot();
    const body = { text: "Synthetic correction", requestKey: "linked-perio:guarded" };
    const target = `${path()}/exams/${first.exam.id}/addenda`;
    for (const invalid of [{ text: "", requestKey: body.requestKey }, { text: body.text }, { ...body, requestKey: "short" }]) {
      expect((await add(first.exam.id, invalid)).status).toBe(400);
    }
    for (const session of [context.h.sessions.reception, context.h.sessions.cashier, context.h.sessions.accountant]) {
      expect((await add(first.exam.id, body, session)).status).toBe(403);
    }
    expect((await fetch(`${baseUrl}${target}`, { method: "POST", redirect: "manual",
      headers: { Origin: baseUrl, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(401);
    expect((await add(first.exam.id, body, context.h.sessions.doctorA, { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await fetch(`${baseUrl}${target}`, { method: "POST", redirect: "manual",
      headers: { Cookie: context.h.sessions.doctorA.cookie, "Content-Type": "application/json" }, body: JSON.stringify(body) })).status).toBe(403);
    expect(await snapshot()).toEqual(before);
    expect((await add(first.exam.id, body)).status).toBe(201);
  });
});
