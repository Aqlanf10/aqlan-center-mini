/** M2 slice 67: canonical lab-order commands (PATCH /api/lab/[id] status, due date and
 * events; DELETE /api/lab/[id]) on real PostgreSQL, synthetic data only. The order row is
 * locked first; the patient scope bounds every command; cancel after dispatch needs
 * clinical.lab.cancel; the payable is recognised once and an unpaid one is removed on
 * cancel; audit rows commit with the write; concurrent moves serialize (one wins). */
vi.mock("server-only", () => ({}));
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool, type PoolConfig } from "pg";
import { assertRealPostgresUrl, stubPostgresEnv } from "./_setup";
import { openCanonicalInventoryDatabase, type CanonicalInventoryDatabase } from "./_canonical-inventory-fixture";
import { waitForBlockedBy } from "./_canonical-ready-fixture";
assertRealPostgresUrl();
stubPostgresEnv();
vi.stubEnv("SESSION_SECRET", "synthetic-canonical-lab-orders-2026-xyz");
const db = await import("../../lib/db");
const lab = await import("../../lib/canonical-lab-orders");

const ACCOUNTS = {
  owner: { username: "SYN-LO-OWNER", role: "admin" },
  coordinator: { username: "SYN-LO-COORD", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  manager: { username: "SYN-LO-MGR", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.order": true, "clinical.lab.cancel": true } },
  canceller: { username: "SYN-LO-CANCEL", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true, "clinical.lab.cancel": true } },
  doctor: { username: "SYN-LO-DOC", role: "doctor", doctor: true, patientScope: "own", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
  viewer: { username: "SYN-LO-VIEW", role: "reception", patientScope: "all", grants: { "clinical.lab.view": true } },
  noScope: { username: "SYN-LO-NOSCOPE", role: "reception", grants: { "clinical.lab.view": true, "clinical.lab.order": true } },
} as const;
type Key = keyof typeof ACCOUNTS;
let fx: CanonicalInventoryDatabase<Key>;
const q = async (sql: string, args: unknown[] = []) => (await fx.pool.query(sql, args)).rows;
const ctx = { mine: 0, theirs: 0, labParty: 0 };
let serial = 0;

async function order(status = "sent", patient: "mine" | "theirs" = "theirs", cost: number | null = 40000): Promise<number> {
  serial += 1;
  return (await q(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,sent_date,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor)
    VALUES ($1,$2,'SYN Lab Orders','Synthetic crown ${serial}',$3,'2031-01-01','2031-01-10',$4,$5,$6,$4) RETURNING id`,
  [ctx[patient], ctx.labParty, status, cost, cost === null ? null : "YER", 1]))[0].id as number;
}
const statusOf = async (id: number) => (await q("SELECT status FROM lab_orders WHERE id=$1", [id]))[0]?.status as string | undefined;
const payables = async (id: number) => (await q("SELECT id, amount_minor::int AS amount FROM payables WHERE lab_order_id=$1", [id]));
const tracking = async (id: number, to?: string) => (await q(
  "SELECT action, from_status, to_status, actor, notes FROM lab_order_tracking WHERE lab_order_id=$1 AND ($2::text IS NULL OR to_status=$2) ORDER BY id", [id, to ?? null]));
const audits = async (action: string, id: number) => (await q("SELECT actor, details FROM audit_log WHERE action=$1 AND entity_id=$2::text", [action, id]));
const refusal = (promise: Promise<unknown>) => promise.then(() => null, (error: { code?: string; status?: number; message?: string }) => error);

beforeAll(async () => {
  fx = await openCanonicalInventoryDatabase(db, ACCOUNTS, "owner");
  const patient = async (number: string, doctor: number | null) =>
    (await q("INSERT INTO patients(patient_number,full_name,phone,primary_doctor_id) VALUES ($1,$2,'0500000900',$3) RETURNING id", [number, `SYN Lab ${number}`, doctor]))[0].id as number;
  ctx.mine = await patient("SYN-LO-1", fx.parties.doctor!);
  ctx.theirs = await patient("SYN-LO-2", null);
  ctx.labParty = (await q("INSERT INTO parties(name,kind,currency) VALUES('SYN Lab Orders','lab','YER') RETURNING id"))[0].id;
}, 180_000);
afterAll(async () => { await fx?.close(); });

describe("status", () => {
  it("moves through the transition map with tracking by the admitted actor; receipt recognises the saved cost once", async () => {
    const id = await order();
    const coordinator = await fx.session("coordinator");
    const started = await lab.commandCanonicalLabStatus(coordinator, String(id), { status: "in_progress", expectedStatus: "sent" });
    expect(started.order.status).toBe("in_progress");
    // The clinical projection: no money group without finance.cost-prices.view.
    expect(started.projection.costs).toBe(false);
    expect(started.order).not.toHaveProperty("costMinor");
    await lab.commandCanonicalLabStatus(coordinator, String(id), { status: "received", note: "وصل سليمًا" });
    expect(await payables(id)).toEqual([{ id: expect.any(Number), amount: 40000 }]);
    expect((await q("SELECT financial_status FROM lab_orders WHERE id=$1", [id]))[0].financial_status).toBe("payable_created");
    expect(await tracking(id)).toEqual([
      { action: "status_change", from_status: "sent", to_status: "in_progress", actor: "SYN-LO-COORD", notes: null },
      { action: "status_change", from_status: "in_progress", to_status: "received", actor: "SYN-LO-COORD", notes: "وصل سليمًا" },
    ]);
    // The owner holds the cost capability.
    const owner = await lab.commandCanonicalLabStatus(await fx.session("owner"), String(id), { status: "delivered" });
    expect(owner).toMatchObject({ projection: { costs: true }, order: { status: "delivered", costMinor: 40000 } });
    expect(await payables(id)).toHaveLength(1);
  });

  it("a stale screen (expectedStatus) and an impossible move are refused without writing", async () => {
    const id = await order();
    const coordinator = await fx.session("coordinator");
    expect(await refusal(lab.commandCanonicalLabStatus(coordinator, String(id), { status: "delivered", expectedStatus: "received" })))
      .toMatchObject({ code: "lab_status_changed", status: 409 });
    expect(await refusal(lab.commandCanonicalLabStatus(coordinator, String(id), { status: "delivered" })))
      .toMatchObject({ code: "lab_status_changed", status: 409 });
    expect(await refusal(lab.commandCanonicalLabStatus(coordinator, String(id), { status: "lost" }))).toMatchObject({ code: "invalid_lab_order" });
    expect(await refusal(lab.commandCanonicalLabStatus(coordinator, "1e3", { status: "received" }))).toMatchObject({ code: "invalid_lab_order" });
    expect([await statusOf(id), await tracking(id), await payables(id)]).toEqual(["sent", [], []]);
    // The prescription gate is the legacy writer's own.
    const needed = await order("needed", "theirs", null);
    expect(await refusal(lab.commandCanonicalLabStatus(coordinator, String(needed), { status: "sent" }))).toMatchObject({ code: "lab_prescription_required" });
    expect(await statusOf(needed)).toBe("needed");
  });

  it("the patient scope bounds the order: own = the clinician's patients, another answers like a missing order; none and no grant refused", async () => {
    const mine = await order("sent", "mine"), theirs = await order();
    const doctor = await fx.session("doctor");
    expect((await lab.commandCanonicalLabStatus(doctor, String(mine), { status: "in_progress" })).order.status).toBe("in_progress");
    expect(await refusal(lab.commandCanonicalLabStatus(doctor, String(theirs), { status: "in_progress" }))).toMatchObject({ code: "lab_order_not_found", status: 404 });
    expect(await refusal(lab.commandCanonicalLabStatus(doctor, "999999", { status: "in_progress" }))).toMatchObject({ code: "lab_order_not_found", status: 404 });
    await expect(lab.commandCanonicalLabStatus(await fx.session("noScope"), String(theirs), { status: "in_progress" })).rejects.toThrow("RECORD_SCOPE_DENIED");
    await expect(lab.commandCanonicalLabStatus(await fx.session("viewer"), String(theirs), { status: "in_progress" })).rejects.toThrow("CAPABILITY_DENIED");
    await expect(lab.commandCanonicalLabStatus(await fx.session("canceller"), String(theirs), { status: "cancelled" })).rejects.toThrow("CAPABILITY_DENIED");
    expect(await statusOf(theirs)).toBe("sent");
  });
});

describe("cancel", () => {
  it("cancel before dispatch is operational; after dispatch it needs clinical.lab.cancel; the audit commits with the cancel", async () => {
    const needed = await order("needed", "theirs", null);
    const coordinator = await fx.session("coordinator");
    await lab.commandCanonicalLabStatus(coordinator, String(needed), { status: "cancelled", note: "طلب مكرر" });
    expect(await statusOf(needed)).toBe("cancelled");
    expect(await audits("lab_order.cancel", needed)).toEqual([{ actor: "SYN-LO-COORD", details: expect.objectContaining({ from: "needed", note: "طلب مكرر" }) }]);

    const sent = await order();
    await expect(lab.commandCanonicalLabStatus(coordinator, String(sent), { status: "cancelled" })).rejects.toThrow("CAPABILITY_DENIED");
    expect([await statusOf(sent), await audits("lab_order.cancel", sent)]).toEqual(["sent", []]);
  });

  it("cancelling received work removes the unpaid payable (exempt) — never a paid one's trace", async () => {
    const id = await order();
    const manager = await fx.session("manager");
    await lab.commandCanonicalLabStatus(manager, String(id), { status: "received" });
    expect(await payables(id)).toHaveLength(1);
    await lab.commandCanonicalLabStatus(manager, String(id), { status: "cancelled", expectedStatus: "received" });
    expect(await payables(id)).toEqual([]);
    expect((await q("SELECT status, payable_id, financial_status FROM lab_orders WHERE id=$1", [id]))[0]).toEqual({ status: "cancelled", payable_id: null, financial_status: "exempt" });
    expect(await audits("lab_order.cancel", id)).toEqual([{ actor: "SYN-LO-MGR", details: expect.objectContaining({ from: "received", costMinor: 40000 }) }]);
  });
});

describe("concurrency", () => {
  it("two devices press «received» together: one wins, one payable, one tracking row; the other is told it changed", async () => {
    const id = await order();
    const [a, b] = [await fx.session("coordinator"), await fx.session("manager")];
    const results = await Promise.allSettled([
      lab.commandCanonicalLabStatus(a, String(id), { status: "received", expectedStatus: "sent" }),
      lab.commandCanonicalLabStatus(b, String(id), { status: "received", expectedStatus: "sent" }),
    ]);
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter(result => result.status === "rejected").map(result => (result as PromiseRejectedResult).reason.code)).toEqual(["lab_status_changed"]);
    expect(await payables(id)).toHaveLength(1);
    expect(await tracking(id, "received")).toHaveLength(1);
  });

  it("cancel races receive on the same screen state: exactly one applies and the money stays consistent", async () => {
    for (let round = 0; round < 3; round += 1) {
      const id = await order();
      const results = await Promise.allSettled([
        lab.commandCanonicalLabStatus(await fx.session("manager"), String(id), { status: "cancelled", expectedStatus: "sent" }),
        lab.commandCanonicalLabStatus(await fx.session("coordinator"), String(id), { status: "received", expectedStatus: "sent" }),
      ]);
      expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
      const status = await statusOf(id);
      if (status === "cancelled") expect([await payables(id), (await audits("lab_order.cancel", id)).length]).toEqual([[], 1]);
      else expect([status, (await payables(id)).length, (await audits("lab_order.cancel", id)).length]).toEqual(["received", 1, 0]);
    }
  });

  it("a move waits on the row lock held by another writer, then reads the moved status", async () => {
    const id = await order();
    // A side pool: the holder and the observer must not starve the writer.
    const side = new Pool({ ...(fx.pool as unknown as { options: PoolConfig }).options, max: 3 });
    const holder = await side.connect();
    try {
      await holder.query("BEGIN");
      const pid = (await holder.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      await holder.query("SELECT id FROM lab_orders WHERE id=$1 FOR UPDATE", [id]);
      const pending = refusal(lab.commandCanonicalLabStatus(await fx.session("coordinator"), String(id), { status: "in_progress", expectedStatus: "sent" }));
      try {
        expect((await waitForBlockedBy(side, pid, 10_000)).length).toBeGreaterThan(0);
        await holder.query("UPDATE lab_orders SET status='in_progress' WHERE id=$1", [id]);
      } finally { await holder.query("COMMIT"); }
      expect(await pending).toMatchObject({ code: "lab_status_changed" });
      expect(await tracking(id)).toEqual([]);
    } finally { holder.release(); await side.end(); }
  });
});

describe("due date", () => {
  it("moves the promised date of open work (in manufacture and remake included) with a tracking row by the actor", async () => {
    const id = await order("in_progress");
    const result = await lab.commandCanonicalLabDueDate(await fx.session("coordinator"), String(id), { dueDate: "2031-01-20" });
    expect(result.order.dueDate).toBe("2031-01-20");
    expect(await tracking(id)).toEqual([{ action: "due_date_change", from_status: null, to_status: null, actor: "SYN-LO-COORD", notes: "تأجيل موعد التسليم إلى 2031-01-20" }]);
    const remake = await order("remake");
    expect((await lab.commandCanonicalLabDueDate(await fx.session("coordinator"), String(remake), { dueDate: "2031-02-01" })).order.dueDate).toBe("2031-02-01");
  });
  it("refuses arrived work, impossible dates, other patients and missing grants", async () => {
    const delivered = await order("delivered"), theirs = await order();
    const coordinator = await fx.session("coordinator");
    expect(await refusal(lab.commandCanonicalLabDueDate(coordinator, String(delivered), { dueDate: "2031-01-20" }))).toMatchObject({ code: "lab_due_date_closed", status: 409 });
    expect(await refusal(lab.commandCanonicalLabDueDate(coordinator, String(theirs), { dueDate: "2031-02-31" }))).toMatchObject({ code: "invalid_lab_order" });
    expect(await refusal(lab.commandCanonicalLabDueDate(await fx.session("doctor"), String(theirs), { dueDate: "2031-01-20" }))).toMatchObject({ code: "lab_order_not_found" });
    await expect(lab.commandCanonicalLabDueDate(await fx.session("viewer"), String(theirs), { dueDate: "2031-01-20" })).rejects.toThrow("CAPABILITY_DENIED");
    expect((await q("SELECT due_date::text AS d FROM lab_orders WHERE id IN ($1,$2) ORDER BY id", [delivered, theirs])).map(row => row.d)).toEqual(["2031-01-10", "2031-01-10"]);
  });
  it("the legacy writer shares the rule and now commits the date and its tracking row together", async () => {
    const id = await order("in_progress");
    expect((await db.setLabOrderDueDate(id, "2031-03-01", "legacy-actor"))?.dueDate).toBe("2031-03-01");
    expect((await tracking(id)).map(row => row.actor)).toEqual(["legacy-actor"]);
    expect(await db.setLabOrderDueDate(await order("received"), "2031-03-01")).toBeNull();
  });
});

describe("events", () => {
  it("reads one order's tracking inside the patient scope", async () => {
    const id = await order();
    await lab.commandCanonicalLabStatus(await fx.session("coordinator"), String(id), { status: "in_progress" });
    const read = await lab.readCanonicalLabEvents(await fx.session("viewer"), String(id));
    expect(read.events.map(event => [event.toStatus, event.actor])).toEqual([["in_progress", "SYN-LO-COORD"]]);
    expect(await refusal(lab.readCanonicalLabEvents(await fx.session("doctor"), String(id)))).toMatchObject({ code: "lab_order_not_found" });
    await expect(lab.readCanonicalLabEvents(await fx.session("noScope"), String(id))).rejects.toThrow(/SCOPE/);
  });
});

describe("delete", () => {
  it("clinical.lab.cancel deletes with a reason; the audit row and the unpaid payable go in the same transaction", async () => {
    const id = await order();
    await lab.commandCanonicalLabStatus(await fx.session("manager"), String(id), { status: "received" });
    expect(await payables(id)).toHaveLength(1);
    expect(await refusal(lab.commandCanonicalLabDelete(await fx.session("canceller"), String(id), "x"))).toMatchObject({ code: "lab_reason_required", status: 400 });
    await expect(lab.commandCanonicalLabDelete(await fx.session("coordinator"), String(id), "سجل مكرر")).rejects.toThrow("CAPABILITY_DENIED");
    expect(await lab.commandCanonicalLabDelete(await fx.session("canceller"), String(id), "سجل مكرر")).toEqual({ ok: true });
    expect([await statusOf(id), await payables(id), await tracking(id)]).toEqual([undefined, [], []]);
    expect(await audits("lab_order.delete", id)).toEqual([{ actor: "SYN-LO-CANCEL", details: expect.objectContaining({ status: "received", reason: "سجل مكرر", costMinor: 40000 }) }]);
  });
  it("answers a missing order as missing; a canceller without patient scope is refused; nothing is written", async () => {
    const id = await order();
    expect(await refusal(lab.commandCanonicalLabDelete(await fx.session("canceller"), "999999", "سجل مكرر"))).toMatchObject({ code: "lab_order_not_found" });
    await expect(lab.commandCanonicalLabDelete(await fx.session("noScope"), String(id), "سجل مكرر")).rejects.toThrow("CAPABILITY_DENIED");
    expect([await statusOf(id), await audits("lab_order.delete", id)]).toEqual(["sent", []]);
  });
});
