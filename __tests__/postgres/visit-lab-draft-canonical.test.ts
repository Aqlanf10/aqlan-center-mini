/** M2 slice 87: the visit's lab draft and the signing of lab work on the canonical runtime,
 * real PostgreSQL, synthetic data only. The lab layer binds receipts, identities and order
 * tracking to the canonical actor (canonicalLabActor) once the canonical operation has
 * proved clinical.lab.order, the patient scope and the clinician-or-owner rule; an exact
 * replay returns the saved result; a deterministic rejection is settled durably; signing
 * materializes the lab order only for a lab-order holder. */
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import type { LabWorkDraft } from "../../lib/lab-work-intent-contract";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-visit-lab-draft-secret-87");
const db = await import("../../lib/db");
const doc = await import("../../lib/canonical-visit-documentation");
const cockpit = await import("../../lib/canonical-visit-clinical");
const lab = await import("../../lib/lab-work-intent-db");

const DOC = { "clinical.visits.document": true, "clinical.visits.sign": true };
const ACCOUNTS = {
  owner: { username: "SYN-VL-OWNER", role: "admin" },
  doctor: { username: "SYN-VL-DR", role: "doctor", doctor: true, patientScope: "all", grants: { ...DOC, "clinical.lab.view": true, "clinical.lab.order": true } },
  plain: { username: "SYN-VL-PLAIN", role: "doctor", doctor: true, patientScope: "all", grants: DOC },
  assistant: { username: "SYN-VL-ASST", role: "assistant", patientScope: "all", grants: { ...DOC, "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; extra?: Record<string, unknown> }) => error);
const act = async (key: Key, visitId: number, body: Record<string, unknown>) => doc.commandCanonicalVisitDocument(await fx.session(key), String(visitId), body, fx.pool);
let patientId = 0, serviceId = 0, serial = 0;
const work = (): LabWorkDraft => ({ intentId: randomUUID(), memberId: randomUUID(), expectedRevision: 0, groupKind: "single",
  prescription: { partyId: null, shade: "", stumpShade: "", toothNumbers: "", dueDate: "2026-11-30", impressionType: "physical", priority: "normal" } });
const visit = async () => (await q("INSERT INTO visits (patient_name, patient_id, doctor_id) VALUES ('SYN VL',$1,$2) RETURNING id", [patientId, fx.parties.doctor]))[0].id as number;
const body = (draft: LabWorkDraft, key = `syn-vl-key-${++serial}`) => ({
  action: "save", doctorId: fx.parties.doctor, labPatientId: patientId, labRequestKey: key,
  procedures: [{ serviceId, toothCode: 27, quantity: 1, doctorId: fx.parties.doctor, labWork: draft }],
});

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  expect(await lab.labWorkIntentSupported(fx.pool)).toBe(true);
  patientId = (await q("INSERT INTO patients(patient_number,full_name) VALUES ('SYN-VL-1','SYN VL patient') RETURNING id"))[0].id;
  serviceId = (await q("INSERT INTO services(name,category,price_minor,is_active,price_configured) VALUES('SYN VL crown','crown',15000,TRUE,TRUE) RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("lab draft inside the canonical save", () => {
  it("a clinician with clinical.lab.order saves the draft; the receipt and identity bind to the canonical actor; an exact replay returns the saved result", async () => {
    const v = await visit(), draft = work(), sent = body(draft);
    const saved = await act("doctor", v, sent) as { labWorkCommand: Record<string, unknown>; procedures: { labWork?: unknown }[] };
    expect(saved.labWorkCommand).toMatchObject({ requestKey: sent.labRequestKey, visitId: v, patientId, actor: "SYN-VL-DR", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(saved.procedures[0].labWork).toMatchObject({ intentId: draft.intentId, memberId: draft.memberId, expectedRevision: 1 });
    expect(await q("SELECT actor_user_id FROM lab_work_commands WHERE request_key=$1", [sent.labRequestKey])).toEqual([{ actor_user_id: fx.ids.doctor }]);
    expect(await q("SELECT created_by_user_id, origin_visit_id FROM lab_work_intents WHERE id=$1", [draft.intentId])).toEqual([{ created_by_user_id: fx.ids.doctor, origin_visit_id: v }]);
    const replay = await act("doctor", v, sent) as { labWorkCommand: Record<string, unknown> };
    expect(replay.labWorkCommand).toEqual(saved.labWorkCommand);
    expect((await q("SELECT count(*)::int AS n FROM lab_work_intents WHERE origin_visit_id=$1", [v]))[0].n).toBe(1);
    const receipt = await cockpit.readCanonicalVisitLabCommand(await fx.session("doctor"), String(v), sent.labRequestKey, String(saved.labWorkCommand.requestHash), fx.pool);
    expect(receipt).toMatchObject({ found: true, result: { outcome: "applied" } });
  });

  it("authority before validation: no lab grant, no clinician link, invalid identity, another patient", async () => {
    const v = await visit();
    expect(await refusal(act("plain", v, body(work())))).toMatchObject({ code: "lab_order_not_granted", status: 403 });
    expect(await refusal(act("assistant", v, body(work())))).toMatchObject({ code: "lab_draft_clinician_only", status: 403 });
    expect(await refusal(act("doctor", v, { ...body(work()), labRequestKey: "bad" }))).toMatchObject({ code: "invalid_lab_command", status: 400 });
    expect(await refusal(act("doctor", v, { ...body(work()), labPatientId: patientId + 100000 }))).toMatchObject({ code: "source_changed", status: 409 });
    expect((await q("SELECT count(*)::int AS n FROM lab_work_intents WHERE origin_visit_id=$1", [v]))[0].n).toBe(0);
  });

  it("a deterministic rejection rolls back and is settled durably for the canonical actor", async () => {
    const v = await visit(), draft = work();
    await act("doctor", v, body(draft));
    const stale = body(draft); // the same identity at revision 0 after it moved to 1
    const refused = await refusal(act("doctor", v, stale));
    expect(refused).toMatchObject({ code: "stale_intent", status: 409, extra: { labWorkOutcome: "rejected", labWorkCommand: { requestKey: stale.labRequestKey, actor: "SYN-VL-DR" } } });
    expect(await q("SELECT actor_user_id, result->>'outcome' AS outcome, result->>'code' AS code FROM lab_work_commands WHERE request_key=$1", [stale.labRequestKey]))
      .toEqual([{ actor_user_id: fx.ids.doctor, outcome: "rejected", code: "stale_intent" }]);
  });
});

describe("signing a visit with lab work", () => {
  it("only a lab-order holder signs it; the order materializes bound to the canonical actor", async () => {
    const v = await visit(), draft = work();
    await act("doctor", v, body(draft));
    const read = await cockpit.readCanonicalVisitClinical(await fx.session("doctor"), v) as { labReviewVersion?: string };
    expect(read.labReviewVersion).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(read)).not.toMatch(/labSignVersion|unitPriceMinor|15000/);
    expect(await refusal(act("plain", v, { action: "sign", labReviewVersion: read.labReviewVersion }))).toMatchObject({ code: "lab_order_not_granted", status: 403 });
    expect(await refusal(act("doctor", v, { action: "sign", labReviewVersion: "0".repeat(64) }))).toMatchObject({ code: "stale_lab_sign_review", status: 409 });
    expect((await q("SELECT signed_at FROM visits WHERE id=$1", [v]))[0].signed_at).toBeNull();
    await act("doctor", v, { action: "sign", labReviewVersion: read.labReviewVersion });
    expect((await q("SELECT signed_at FROM visits WHERE id=$1", [v]))[0].signed_at).not.toBeNull();
    const [order] = await q("SELECT o.id, t.actor FROM lab_orders o JOIN lab_order_tracking t ON t.lab_order_id=o.id AND t.action='work_intent_materialized' WHERE o.lab_work_intent_id=$1", [draft.intentId]);
    expect(order).toMatchObject({ actor: "SYN-VL-DR" });
  });

  it("a JSON object can never pass as a canonical actor", async () => {
    const v = await visit();
    const forged = { userId: fx.ids.doctor, username: "SYN-VL-DR", role: "doctor", [Symbol("canonical-lab-actor")]: true };
    await expect(db.setVisitProcedures({ visitId: v, procedures: [{ serviceId, toothCode: 27, surfaces: null, quantity: 1, unitPriceMinor: 15000, doctorId: fx.parties.doctor!, note: null, labWork: work() }],
      labCommand: { expectedPatientId: patientId, requestKey: `syn-vl-forged-${++serial}`, requestHash: "forged", session: forged as never } })).rejects.toBeTruthy();
    expect((await q("SELECT count(*)::int AS n FROM lab_work_intents WHERE origin_visit_id=$1", [v]))[0].n).toBe(0);
  });
});
