import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validatePostgresTestTarget } from "./_safe-target";
import { stubPostgresEnv } from "./_setup";
import { sessionCredentialVersion, sessionPermissionVersion, type SessionPayload } from "../../lib/auth";
validatePostgresTestTarget(process.env); stubPostgresEnv();
const db = await import("../../lib/db");
const q = async (sql: string, values: unknown[] = []) => (await db.getPool().query(sql, values)).rows;
let admin: SessionPayload, reception: SessionPayload, doctor: SessionPayload;
async function actor(role: "admin" | "reception" | "doctor" | "cashier"): Promise<SessionPayload> {
  const username = `lab-status-${randomUUID()}`;
  const [user] = await q("INSERT INTO users(username,display_name,password_hash,role) VALUES($1,'Synthetic lab status','synthetic-lab-status-hash',$2) RETURNING id", [username, role]);
  return { userId: user.id, username, role, expiresAt: Date.now() + 3600000, credentialVersion: sessionCredentialVersion("synthetic-lab-status-hash"),
    ...(role === "cashier" ? { permissionVersion: sessionPermissionVersion(role, undefined) } : {}) };
}
beforeAll(async () => { await db.ensureSchema(); admin = await actor("admin"); reception = await actor("reception"); doctor = await actor("doctor"); }, 180000);
afterAll(async () => { await db.resetPoolForTesting(); });
async function fixture(status = "sent", money = true) {
  const [patient] = await q("INSERT INTO patients(patient_number,full_name) VALUES($1,'Synthetic lab status patient') RETURNING id", [`LST-${randomUUID()}`]);
  const [lab] = await q("INSERT INTO parties(name,kind,currency) VALUES('Synthetic status lab','lab','USD') RETURNING id");
  const [order] = await q(`INSERT INTO lab_orders(patient_id,party_id,lab_name,work_type,status,due_date,cost_minor,cost_currency,exchange_rate,base_amount_minor)
    VALUES($1,$2,'Synthetic status lab','crown',$3,'2026-11-01',$4,$5,531.125,$6) RETURNING id`, [patient.id, lab.id, status, money ? 2500 : null, money ? "USD" : null, money ? 13001 : null]);
  return order.id as number;
}
describe("lab status saved-money and live actor boundary", () => {
  it("revalidates financial sessions and preserves cashier financial-only authority", async () => {
    const id = await fixture("needed", false);
    const input = { costMinor: 200, costCurrency: "YER" as const, exchangeRate: 1 };
    await expect(db.updateLabOrderAccounting(id, { ...input, session: doctor })).rejects.toMatchObject({ code: "lab_accounting_forbidden" });
    await expect(db.updateLabOrderAccounting(id, { ...input, session: { ...admin, expiresAt: 1 } })).rejects.toMatchObject({ code: "lab_accounting_forbidden" });
    const cashier = await actor("cashier");
    expect((await db.updateLabOrderAccounting(id, { ...input, session: cashier }))?.costMinor).toBe(200);
    await q("UPDATE users SET role='doctor' WHERE id=$1", [cashier.userId]);
    const before = await q("SELECT * FROM lab_orders WHERE id=$1", [id]);
    await expect(db.updateLabOrderAccounting(id, { isPosted: false, session: cashier })).rejects.toMatchObject({ code: "lab_accounting_forbidden" });
    expect(await q("SELECT * FROM lab_orders WHERE id=$1", [id])).toEqual(before);
  });

  it("receives once using the exact saved USD snapshot and one payable", async () => {
    const id = await fixture();
    const received = await Promise.all([1, 2].map(() => db.setLabOrderStatus(id, "received", { session: reception })));
    expect(received.filter(Boolean)).toHaveLength(1);
    expect(received.filter(value => value === null)).toHaveLength(1);
    const rows = await q("SELECT amount_minor,currency,exchange_rate,base_amount_minor FROM payables WHERE lab_order_id=$1", [id]);
    expect(rows).toEqual([{ amount_minor: "2500", currency: "USD", exchange_rate: "531.125000", base_amount_minor: "13001" }]);
  });
  it("refuses an unlinked existing payable instead of silently receiving", async () => {
    const id = await fixture();
    await q(`INSERT INTO payables(party_id,category,description,amount_minor,currency,exchange_rate,base_amount_minor,base_currency,lab_order_id,due_date,created_by)
      SELECT party_id,'lab','Synthetic inconsistent linkage',cost_minor,cost_currency,exchange_rate,base_amount_minor,'YER',id,due_date,'synthetic' FROM lab_orders WHERE id=$1`, [id]);
    await expect(db.setLabOrderStatus(id, "received", { session: admin })).rejects.toMatchObject({ code: "lab_payable_link_review" });
    expect((await db.getLabOrderById(id))?.status).toBe("sent");
    expect(await q("SELECT id FROM payables WHERE lab_order_id=$1", [id])).toHaveLength(1);
  });
  it("refuses missing saved FX/base without changing status or creating a payable", async () => {
    const id = await fixture(); await q("UPDATE lab_orders SET base_amount_minor=NULL WHERE id=$1", [id]);
    await expect(db.setLabOrderStatus(id, "received", { session: admin })).rejects.toMatchObject({ code: "lab_saved_money_review" });
    expect((await db.getLabOrderById(id))?.status).toBe("sent");
    expect(await q("SELECT id FROM payables WHERE lab_order_id=$1", [id])).toHaveLength(0);
  });
  it("refuses unassigned doctor, revoked session and non-admin sent cancellation", async () => {
    const id = await fixture();
    await expect(db.setLabOrderStatus(id, "received", { session: doctor })).rejects.toMatchObject({ code: "lab_patient_forbidden" });
    await expect(db.setLabOrderStatus(id, "received", { session: { ...admin, expiresAt: 1 } })).rejects.toMatchObject({ code: "lab_status_forbidden" });
    await expect(db.setLabOrderStatus(id, "cancelled", { session: reception })).rejects.toMatchObject({ code: "lab_cancel_forbidden" });
    expect((await db.getLabOrderById(id))?.status).toBe("sent");
  });
  it("does not allow direct status changes to dispatch incomplete prescriptions", async () => {
    const id = await fixture("needed", false);
    await expect(db.setLabOrderStatus(id, "sent", { session: admin })).rejects.toMatchObject({ code: "lab_prescription_required" });
    expect((await db.getLabOrderById(id))?.status).toBe("needed");
  });
});
