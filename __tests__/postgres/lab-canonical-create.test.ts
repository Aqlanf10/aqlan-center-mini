/** M2 slice 68: canonical lab-order creation (POST /api/lab) on real PostgreSQL,
 * synthetic data only. A request key prevents duplicates (double press, concurrent
 * retries, retry after a lost response); a failed attempt commits nothing so its retry
 * creates once; money and posting fields are refused; the patient scope, the doctor
 * binding, the lab directory and the visit/tooth guard hold; the receipt is the atomic
 * lab_order.create audit row. */
vi.mock("server-only", () => ({}));
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-create-2026-xyz");
const db = await import("../../lib/db");
const create = await import("../../lib/canonical-lab-create");

const ACCOUNTS = {
  owner: { username: "SYN-LC-OWNER", role: "admin" },
  coordinator: { username: "SYN-LC-COORD", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  second: { username: "SYN-LC-SECOND", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  doctor: { username: "SYN-LC-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  viewer: { username: "SYN-LC-VIEW", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true } },
  noScope: { username: "SYN-LC-NOSCOPE", role: "reception", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ctx = { mine: 0, theirs: 0, lab: 0, pricedLab: 0, service: 0, otherDoctor: 0, visit: 0 };
const key = () => randomUUID();
const body = (extra: Record<string, unknown> = {}) => ({
  requestKey: key(), patientId: ctx.theirs, workType: "Synthetic crown", partyId: ctx.lab, doctorId: ctx.otherDoctor,
  sentDate: "2031-04-01", dueDate: "2031-04-08", toothNumbers: "16", ...extra,
});
const ordersOf = async (patientId: number) => (await q("SELECT id FROM lab_orders WHERE patient_id=$1 ORDER BY id", [patientId])).map(row => row.id as number);
const receipts = async (requestKey: string) => (await q("SELECT entity_id, actor FROM audit_log WHERE action='lab_order.create' AND details->>'requestKey'=$1", [requestKey]));
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; field?: string }) => error);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000950',$3) RETURNING id", [number, `SYN Lab ${number}`, doctor]))[0].id as number;
  ctx.mine = await patient("SYN-LC-1", fx.parties.doctor!);
  ctx.theirs = await patient("SYN-LC-2", null);
  ctx.lab = (await q("INSERT INTO parties(name,kind,currency,phone) VALUES('SYN Lab Create','lab','YER','0500000951') RETURNING id"))[0].id;
  ctx.pricedLab = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Priced Lab','lab','YER') RETURNING id"))[0].id;
  ctx.otherDoctor = (await q("INSERT INTO parties(name,kind,is_active) VALUES('SYN Other Doctor','doctor',TRUE) RETURNING id"))[0].id;
  ctx.service = (await q("INSERT INTO lab_services(name,code,category,tooth_scope) VALUES('Synthetic crown','SYN-LC-CROWN','prostho','single_tooth') RETURNING id"))[0].id;
  await q("INSERT INTO lab_pricing_rules(party_id,lab_service_id,cost_minor,cost_currency,effective_from,created_by) VALUES($1,$2,70000,'YER','2026-01-01','synthetic')", [ctx.pricedLab, ctx.service]);
  ctx.visit = (await q("INSERT INTO visits(patient_name,patient_id) VALUES('SYN visit',$1) RETURNING id", [ctx.theirs]))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("create", () => {
  it("creates one sent order with its tracking row and the receipt in the same transaction", async () => {
    const input = body();
    const result = await create.commandCanonicalLabCreate(await fx.session("coordinator"), input);
    expect(result).toMatchObject({ replayed: false, projection: { costs: false }, order: { status: "sent", labName: "SYN Lab Create", doctorId: ctx.otherDoctor, labPhone: "0500000951" } });
    const id = result.order.id;
    expect(await q("SELECT action, to_status, actor FROM lab_order_tracking WHERE lab_order_id=$1", [id])).toEqual([{ action: "create", to_status: "sent", actor: "SYN-LC-COORD" }]);
    expect(await receipts(input.requestKey)).toEqual([{ entity_id: String(id), actor: "SYN-LC-COORD" }]);
  });

  it("the automatic price from the lab's rules is the only money effect, and it is hidden without the cost capability", async () => {
    const coordinator = await create.commandCanonicalLabCreate(await fx.session("coordinator"), body({ partyId: ctx.pricedLab, labServiceId: ctx.service }));
    expect(coordinator.order).not.toHaveProperty("costMinor");
    expect(await q("SELECT amount_minor::int AS amount, is_posted FROM payables WHERE lab_order_id=$1", [coordinator.order.id])).toEqual([{ amount: 70000, is_posted: true }]);
    const owner = await create.commandCanonicalLabCreate(await fx.session("owner"), body({ partyId: ctx.pricedLab, labServiceId: ctx.service }));
    expect(owner).toMatchObject({ projection: { costs: true }, order: { costMinor: 70000 } });
  });

  it("refuses explicit money and posting fields without writing", async () => {
    const before = await ordersOf(ctx.theirs);
    for (const [field, value] of [["cost", "500"], ["costCurrency", "USD"], ["expenseCategoryId", 3], ["expenseAccountCode", "5101"], ["payableAccountCode", "2101"], ["isPosted", false]] as const) {
      expect(await refusal(create.commandCanonicalLabCreate(await fx.session("owner"), body({ [field]: value }))))
        .toMatchObject({ code: "lab_money_not_canonical", status: 409, field });
    }
    expect(await ordersOf(ctx.theirs)).toEqual(before);
  });

  it("needs an active lab from the directory (no party is created from free text) and validates the request", async () => {
    const parties = (await q("SELECT count(*)::int AS n FROM parties"))[0].n;
    const coordinator = await fx.session("coordinator");
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ partyId: undefined, labName: "SYN Brand New Lab" })))).toMatchObject({ code: "invalid_lab_order", field: "partyId" });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ partyId: ctx.otherDoctor })))).toMatchObject({ code: "lab_party_unavailable" });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ requestKey: "short" })))).toMatchObject({ code: "invalid_lab_order", field: "requestKey" });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ dueDate: "2031-03-01" })))).toMatchObject({ field: "dueDate" });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ sentDate: "2031-02-31" })))).toMatchObject({ field: "sentDate" });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ patientId: "1e3" })))).toMatchObject({ field: "patientId" });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, body({ doctorId: undefined })))).toMatchObject({ field: "doctorId" });
    expect((await q("SELECT count(*)::int AS n FROM parties"))[0].n).toBe(parties);
  });
});

describe("duplicate prevention", () => {
  it("a double press with the same key returns the same order (replayed) — one order, one receipt", async () => {
    const coordinator = await fx.session("coordinator");
    const input = body();
    const before = (await ordersOf(ctx.theirs)).length;
    const first = await create.commandCanonicalLabCreate(coordinator, input);
    const second = await create.commandCanonicalLabCreate(coordinator, { ...input });
    expect([first.replayed, second.replayed, second.order.id]).toEqual([false, true, first.order.id]);
    expect((await ordersOf(ctx.theirs)).length).toBe(before + 1);
    expect(await receipts(input.requestKey)).toHaveLength(1);
  });

  it("five concurrent submissions with one key create exactly one order", async () => {
    const coordinator = await fx.session("coordinator");
    const input = body();
    const before = (await ordersOf(ctx.theirs)).length;
    const results = await Promise.all(Array.from({ length: 5 }, () => create.commandCanonicalLabCreate(coordinator, { ...input })));
    expect(results.filter(result => !result.replayed)).toHaveLength(1);
    expect(new Set(results.map(result => result.order.id)).size).toBe(1);
    expect((await ordersOf(ctx.theirs)).length).toBe(before + 1);
    expect(await receipts(input.requestKey)).toHaveLength(1);
  });

  it("the same key with a different request is refused; distinct keys are distinct orders; keys are per actor", async () => {
    const coordinator = await fx.session("coordinator");
    const input = body();
    await create.commandCanonicalLabCreate(coordinator, input);
    const before = await ordersOf(ctx.theirs);
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, { ...input, toothNumbers: "17" }))).toMatchObject({ code: "lab_request_key_reused", status: 409 });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, { ...input, details: "another request" }))).toMatchObject({ code: "lab_request_key_reused" });
    expect(await ordersOf(ctx.theirs)).toEqual(before);
    // Two deliberate orders (two submissions, two keys) are two orders.
    const [a, b] = await Promise.all([create.commandCanonicalLabCreate(coordinator, body()), create.commandCanonicalLabCreate(coordinator, body())]);
    expect(a.order.id).not.toBe(b.order.id);
    // Another actor's identical key never replays someone else's order.
    const other = await create.commandCanonicalLabCreate(await fx.session("second"), { ...input });
    expect(other.replayed).toBe(false);
  });

  it("a failed attempt commits nothing, so its retry with the same key creates once; a key whose order was deleted is not reused", async () => {
    const coordinator = await fx.session("coordinator");
    await q("UPDATE parties SET is_active=FALSE WHERE id=$1", [ctx.lab]);
    const input = body();
    const before = (await ordersOf(ctx.theirs)).length;
    try {
      expect(await refusal(create.commandCanonicalLabCreate(coordinator, input))).toMatchObject({ code: "lab_party_unavailable" });
    } finally { await q("UPDATE parties SET is_active=TRUE WHERE id=$1", [ctx.lab]); }
    expect([(await ordersOf(ctx.theirs)).length, await receipts(input.requestKey)]).toEqual([before, []]);
    const retried = await create.commandCanonicalLabCreate(coordinator, input);
    expect(retried.replayed).toBe(false);
    expect((await ordersOf(ctx.theirs)).length).toBe(before + 1);
    await q("DELETE FROM lab_order_tracking WHERE lab_order_id=$1", [retried.order.id]);
    await q("DELETE FROM lab_orders WHERE id=$1", [retried.order.id]);
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, input))).toMatchObject({ code: "lab_request_key_used" });
    expect((await ordersOf(ctx.theirs)).length).toBe(before);
  });

  it("one tooth per visit: a second order for the same tooth is refused even with a fresh key", async () => {
    const coordinator = await fx.session("coordinator");
    const quick = { patientId: ctx.theirs, visitId: ctx.visit, toothCode: 21, status: "needed", workType: "Synthetic crown" };
    const first = await create.commandCanonicalLabCreate(coordinator, { ...quick, requestKey: key() });
    expect(first.order).toMatchObject({ status: "needed", visitId: ctx.visit });
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, { ...quick, requestKey: key() }))).toMatchObject({ code: "lab_order_exists", status: 409 });
    // A visit of another patient is refused.
    expect(await refusal(create.commandCanonicalLabCreate(coordinator, { ...quick, patientId: ctx.mine, toothCode: 22, requestKey: key() }))).toMatchObject({ field: "visitId" });
  });
});

describe("authority", () => {
  it("own scope: the clinician's own patients only, in its own name; no scope or no grant refused", async () => {
    const doctor = await fx.session("doctor");
    const own = await create.commandCanonicalLabCreate(doctor, body({ patientId: ctx.mine, doctorId: undefined }));
    expect(own.order.doctorId).toBe(fx.parties.doctor);
    expect(await refusal(create.commandCanonicalLabCreate(doctor, body({ patientId: ctx.mine })))).toMatchObject({ code: "lab_doctor_forbidden", status: 403 });
    // A replay respects the current scope: once the patient moves to another doctor, the
    // same key no longer returns the order.
    const input = body({ patientId: ctx.mine, doctorId: undefined });
    expect((await create.commandCanonicalLabCreate(doctor, input)).replayed).toBe(false);
    await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [ctx.mine, ctx.otherDoctor]);
    try {
      expect(await refusal(create.commandCanonicalLabCreate(doctor, input))).toMatchObject({ code: "lab_patient_not_found", status: 404 });
    } finally { await q("UPDATE patients SET primary_doctor_id=$2 WHERE id=$1", [ctx.mine, fx.parties.doctor]); }
    expect((await create.commandCanonicalLabCreate(doctor, input)).replayed).toBe(true);
    expect(await refusal(create.commandCanonicalLabCreate(doctor, body({ doctorId: undefined })))).toMatchObject({ code: "lab_patient_not_found", status: 404 });
    expect(await refusal(create.commandCanonicalLabCreate(doctor, body({ patientId: 999999, doctorId: undefined })))).toMatchObject({ code: "lab_patient_not_found", status: 404 });
    await expect(create.commandCanonicalLabCreate(await fx.session("noScope"), body())).rejects.toThrow("RECORD_SCOPE_DENIED");
    await expect(create.commandCanonicalLabCreate(await fx.session("viewer"), body())).rejects.toThrow("CAPABILITY_DENIED");
  });
});
